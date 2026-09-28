import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditLogger } from '../audit.js';

const base = { ts: '2026-01-01T00:00:00.000Z', tool: 't', decision: 'deny', argsHash: 'abc' };
let dir: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function tmpFile() {
  dir = mkdtempSync(join(tmpdir(), 'mcpolyglot-audit-'));
  return join(dir, 'nested', 'audit.log');
}

describe('AuditLogger', () => {
  it('writes JSONL to stdout by default', async () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await new AuditLogger().append(base);
    expect(JSON.parse(String(spy.mock.calls[0]![0]))).toMatchObject(base);
  });

  it('can target stderr or be silenced', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await new AuditLogger({ console: 'stderr' }).append(base);
    await new AuditLogger({ console: false }).append(base);
    expect(out).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledTimes(1);
  });

  it('file sink appends and never truncates, across logger instances', async () => {
    const path = tmpFile();
    await new AuditLogger({ console: false, path }).append({ ...base, n: 1 });
    await new AuditLogger({ console: false, path }).append({ ...base, n: 2 });
    const lines = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.n)).toEqual([1, 2]);
  });

  it('scrubs credentials and PII from reason and error text, and truncates', async () => {
    const path = tmpFile();
    await new AuditLogger({ console: false, path }).append({
      ...base,
      reason: 'connect postgres://admin:hunter2@db:5432/x failed for alice@example.com',
      error: {
        code: 'x',
        message: 'token eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl ' + 'z'.repeat(1000),
      },
    });
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('admin:');
    expect(raw).not.toContain('alice@example.com');
    expect(raw).not.toContain('eyJhbGciOi');
    const e = JSON.parse(raw);
    expect(e.error.message.length).toBeLessThanOrEqual(501);
  });

  it('webhook receives each entry as JSON', async () => {
    const received: unknown[] = [];
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push(JSON.parse(body));
        res.end();
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    try {
      const log = new AuditLogger({
        console: false,
        webhook: { url: `http://127.0.0.1:${port}/` },
      });
      await log.append(base);
      await log.flush();
      expect(received).toEqual([base]);
    } finally {
      srv.close();
    }
  });

  it('webhook failure never throws and never logs the URL', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const url = 'http://127.0.0.1:1/?token=sekret';
    const log = new AuditLogger({ console: false, webhook: { url, timeoutMs: 500 } });
    await expect(log.append(base)).resolves.toBeUndefined();
    await log.flush();
    expect(err).toHaveBeenCalled();
    expect(String(err.mock.calls.at(-1)![0])).not.toContain('sekret');
  });
});
