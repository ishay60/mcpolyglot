import { mkdir, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { Redactor } from './redactor.js';

export interface AuditLoggerOptions {
  /**
   * JSONL to a console stream. Defaults to `'stdout'`. Use `'stderr'` under the stdio
   * transport, where stdout carries the MCP protocol.
   */
  console?: 'stdout' | 'stderr' | false;
  /** Also append JSONL to this file. */
  path?: string;
  /** Also POST each entry as JSON. Best-effort: failures are reported, never fail the call. */
  webhook?: { url: string; timeoutMs?: number };
}

const MAX_TEXT = 500;
// `scheme://user:password@host` — connection strings in driver error messages.
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;

/**
 * Append-only audit sink. Entries are sanitized before any sink sees them: free-text
 * fields are scrubbed of credentials and PII and truncated. Callers never pass rows or raw
 * args (the server logs an args hash), so this only has to guard error text.
 */
export class AuditLogger {
  private readonly path?: string;
  private readonly stream?: NodeJS.WritableStream;
  private readonly webhook?: { url: string; timeoutMs: number };
  private readonly redactor = new Redactor();
  private readonly pending = new Set<Promise<void>>();
  private dirEnsured = false;

  constructor(opts: AuditLoggerOptions = {}) {
    const target = opts.console ?? 'stdout';
    if (target) this.stream = target === 'stdout' ? process.stdout : process.stderr;
    if (opts.path) this.path = expandHome(opts.path);
    if (opts.webhook) this.webhook = { timeoutMs: 2_000, ...opts.webhook };
  }

  async append(entry: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify(this.sanitize(entry)) + '\n';
    this.stream?.write(line);
    if (this.path) {
      if (!this.dirEnsured) {
        await mkdir(dirname(this.path), { recursive: true });
        this.dirEnsured = true;
      }
      // 'a' flag: O_APPEND, never truncates or seeks.
      await appendFile(this.path, line, { encoding: 'utf8', flag: 'a' });
    }
    if (this.webhook) this.track(this.post(line));
  }

  /** Wait for in-flight webhook posts. Call on shutdown. */
  async flush(): Promise<void> {
    await Promise.all(this.pending);
  }

  private sanitize(entry: Record<string, unknown>): Record<string, unknown> {
    const out = { ...entry };
    if (typeof out.reason === 'string') out.reason = this.scrub(out.reason);
    const err = out.error as { code: string; message: string } | undefined;
    if (err) out.error = { ...err, message: this.scrub(err.message) };
    return out;
  }

  private scrub(s: string): string {
    const text = this.redactor.redactText(s.replace(URL_CREDENTIALS, '$1[REDACTED]@'));
    return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '…' : text;
  }

  private async post(line: string): Promise<void> {
    const { url, timeoutMs } = this.webhook!;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: line,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      // Never echo the URL: it may carry a token.
      process.stderr.write(
        JSON.stringify({
          level: 'warn',
          msg: 'audit.webhook_failed',
          error: (err as Error).message,
        }) + '\n',
      );
    }
  }

  private track(p: Promise<void>): void {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }
}

function expandHome(p: string): string {
  if (p.startsWith('~')) return p.replace(/^~/, homedir());
  return p;
}
