import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '@mcpolyglot/config';
import type { McpolyglotServer } from '@mcpolyglot/core';
import { StreamableHttpTransport } from '@mcpolyglot/core/transports/streamable-http';
import { buildServerFromConfig } from '../factory.js';

// Keeps examples/*/README.md honest: every row of each README's table is exercised here
// against that example's own config and seed.sql, over the real HTTP transport.
const Database = createRequire(new URL('../../../connector-sql/package.json', import.meta.url))(
  'better-sqlite3',
) as new (path: string) => {
  exec(sql: string): void;
  prepare(sql: string): { get(): unknown };
  close(): void;
};

const EXAMPLES = new URL('../../../../examples/', import.meta.url);
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const dir = mkdtempSync(join(tmpdir(), 'mcpolyglot-examples-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let server: McpolyglotServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function boot(example: string) {
  const dbPath = join(dir, `${example}.db`);
  const seed = new Database(dbPath);
  seed.exec(readFileSync(new URL(`${example}/seed.sql`, EXAMPLES), 'utf8'));
  seed.close();

  const raw = JSON.parse(
    readFileSync(new URL(`${example}/mcpolyglot.config.json`, EXAMPLES), 'utf8'),
  );
  raw.sources[0].url = dbPath;
  raw.audit = { console: false, path: join(dir, `${example}.audit.jsonl`) };
  const cfg = ConfigSchema.parse(raw);

  const built = await buildServerFromConfig(cfg, silent);
  server = built.server;
  const transport = new StreamableHttpTransport({
    host: '127.0.0.1',
    port: 0,
    auth: cfg.agents ? { kind: 'agents', agents: cfg.agents } : { kind: 'bearer', token: 'shared' },
    logger: silent,
  });
  await server.start(transport);
  const port = (
    transport as unknown as { httpServer: { address(): { port: number } } }
  ).httpServer.address().port;

  const rpc = async (token: string, method: string, params: Record<string, unknown> = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = await res.text();
    if (res.status !== 200) return { status: res.status, text: body, tools: [] as string[] };
    const line = body.split('\n').find((l) => l.startsWith('data: '));
    const msg = JSON.parse(line ? line.slice(6) : body);
    return {
      status: res.status,
      text: msg.error
        ? `rpc-error: ${msg.error.message}`
        : (msg.result.content ?? []).map((c: { text: string }) => c.text).join(''),
      isError: Boolean(msg.error || msg.result?.isError),
      tools: ((msg.result?.tools ?? []) as { name: string }[]).map((t) => t.name),
    };
  };
  const call = (token: string, name: string, args: Record<string, unknown>) =>
    rpc(token, 'tools/call', { name, arguments: args });
  const count = (sql: string) => {
    const db = new Database(dbPath);
    try {
      return (db.prepare(sql).get() as { n: number }).n;
    } finally {
      db.close();
    }
  };
  return { rpc, call, count };
}

describe('examples/readonly-analytics', () => {
  it('matches the README table', async () => {
    const { call, rpc } = await boot('readonly-analytics');
    const q = (sql: string) => call('shared', 'analytics.query', { sql });

    const plans = await q('SELECT plan, count(*) AS n FROM users GROUP BY plan');
    expect(plans.isError).toBe(false);
    expect(plans.text).toContain('"pro"');
    const joined = await q(
      "SELECT u.plan, count(*) AS exports FROM events e JOIN users u ON u.id = e.user_id WHERE e.name = 'export' GROUP BY u.plan",
    );
    expect(joined.isError).toBe(false);

    expect((await q('SELECT password_hash FROM users')).text).toMatch(
      /forbidden\.policy.*denied column/,
    );
    expect((await q('SELECT * FROM users')).text).toMatch(/forbidden\.policy.*SELECT \*/);
    expect((await q('SELECT body FROM internal_notes')).text).toMatch(
      /forbidden\.policy.*not accessible/,
    );
    expect((await q('DELETE FROM events WHERE id = 1')).text).toMatch(
      /forbidden\.policy.*read-only/,
    );

    const list = (await call('shared', 'analytics.list_tables', {})).text;
    expect(list).not.toContain('internal_notes');
    expect(list).not.toContain('password_hash');
    expect((await rpc('shared', 'tools/list')).tools).not.toContain('analytics.execute');
  });
});

describe('examples/spend-policy', () => {
  it('matches the README table', async () => {
    const { call, count } = await boot('spend-policy');
    const exec = (sql: string, extra: Record<string, unknown> = {}) =>
      call('shared', 'bank.execute', { sql, ...extra });
    const txCount = () => count('SELECT count(*) AS n FROM transactions');

    const coffee =
      "INSERT INTO transactions (account_id, amount_cents, memo) VALUES (1, -2500, 'Coffee')";
    expect((await exec(coffee)).text).toContain('"rowsAffected": 1');
    expect(txCount()).toBe(3);

    const tea = "INSERT INTO transactions (account_id, amount_cents, memo) VALUES (2, -300, 'Tea')";
    await exec(tea, { idempotencyKey: 'coffee-1' });
    await exec(tea, { idempotencyKey: 'coffee-1' });
    expect(txCount()).toBe(4);

    const tv = await exec(
      "INSERT INTO transactions (account_id, amount_cents, memo) VALUES (1, -90000, 'TV')",
    );
    expect(tv.isError).toBe(true);
    expect(tv.text).toMatch(/CHECK/i);
    expect(txCount()).toBe(4);

    expect((await exec('UPDATE accounts SET balance_cents = 999999 WHERE id = 1')).text).toMatch(
      /forbidden\.policy.*read-only/,
    );
    const del = await exec('DELETE FROM transactions WHERE account_id = 1');
    expect(del.text).toMatch(/forbidden\.policy/);
    expect(txCount()).toBe(4);

    expect((await call('shared', 'bank.query', { sql: 'SELECT ssn FROM customers' })).text).toMatch(
      /forbidden\.policy.*denied column/,
    );
    expect((await exec('DROP TABLE transactions')).text).toMatch(
      /forbidden\.policy.*always blocked/,
    );
  });
});

describe('examples/multi-agent', () => {
  it('matches the README table', async () => {
    const { call, rpc } = await boot('multi-agent');
    const support = 'demo-support-token';
    const finance = 'demo-finance-token';

    // support-bot
    expect((await call(support, 'app.query', { sql: 'SELECT email FROM customers' })).isError).toBe(
      false,
    );
    expect(
      (
        await call(support, 'app.execute', {
          sql: "UPDATE tickets SET status = 'closed' WHERE id = 1",
        })
      ).text,
    ).toContain('"rowsAffected": 1');
    expect((await call(support, 'app.query', { sql: 'SELECT id FROM invoices' })).text).toMatch(
      /forbidden\.policy/,
    );
    expect((await call(support, 'app.list_tables', {})).text).not.toContain('invoices');

    // finance-bot
    expect(
      (await call(finance, 'app.query', { sql: 'SELECT id, status FROM invoices' })).isError,
    ).toBe(false);
    expect((await call(finance, 'app.query', { sql: 'SELECT email FROM customers' })).text).toMatch(
      /forbidden\.policy.*denied column/,
    );
    expect((await call(finance, 'app.query', { sql: 'SELECT id FROM tickets' })).text).toMatch(
      /forbidden\.policy/,
    );
    expect((await rpc(finance, 'tools/list')).tools).not.toContain('app.execute');

    // retired-bot
    expect((await rpc('demo-retired-token', 'tools/list')).status).toBe(401);
  });
});
