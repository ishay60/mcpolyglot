import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolDefinition, ToolExecCtx } from '@mcpolyglot/core';
import { SqlConnector } from '../connector.js';
import { SqliteDialect } from '../dialects/sqlite.js';

// Real end-to-end: spin up a SQLite file with sample data, open it via the
// connector, exercise every primitive tool, and assert read-only enforcement.
//
// Skipped if `better-sqlite3` doesn't load (e.g., a CI runner without a
// matching prebuilt binary). The dialect treats it as an optional dep, and
// our test harness should mirror that.
let canRun = true;
try {
  await import('better-sqlite3');
} catch {
  canRun = false;
}

const d = canRun ? describe : describe.skip;

d('sqlite end-to-end via SqlConnector', () => {
  let tmpDir: string;
  let dbPath: string;
  let connector: SqlConnector;
  let tools: Record<string, ToolDefinition>;

  const ctx: ToolExecCtx = {
    sessionId: 'test-session',
    scopes: new Set(['schema:read', 'tables:read', 'query:raw']),
    signal: new AbortController().signal,
    limits: { rowCap: 100, timeoutMs: 5_000, maxBytes: 256 * 1024 },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  };

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mcpolyglot-sqlite-int-'));
    dbPath = join(tmpDir, 'test.db');

    const Database = (await import('better-sqlite3')).default;
    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT,
        password_hash TEXT
      );
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        total_cents INTEGER NOT NULL
      );
      INSERT INTO users (email, name, password_hash) VALUES
        ('alice@example.com', 'Alice', 'argon2id$x'),
        ('bob@example.com',   'Bob',   'argon2id$y');
      INSERT INTO orders (user_id, total_cents) VALUES (1, 4995), (1, 12000), (2, 2500);
    `);
    seed.close();

    connector = new SqlConnector({ id: 'sqlite.test', dialect: new SqliteDialect(dbPath) });
    await connector.init({
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });

    tools = Object.fromEntries(connector.listPrimitiveTools().map((t) => [t.name, t]));
  });

  afterAll(async () => {
    await connector?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exposes the three primitive tools with the right scopes', () => {
    expect(Object.keys(tools).sort()).toEqual([
      'sqlite.test.describe_table',
      'sqlite.test.list_tables',
      'sqlite.test.query',
    ]);
    expect(tools['sqlite.test.list_tables']!.scopes).toEqual(['schema:read']);
    expect(tools['sqlite.test.query']!.scopes).toEqual(['tables:read', 'query:raw']);
    for (const t of Object.values(tools)) expect(t.readOnly).toBe(true);
  });

  it('list_tables returns both seeded tables', async () => {
    const t = tools['sqlite.test.list_tables']!;
    const r = await t.handler({}, ctx);
    const block = r.content[0];
    expect(block?.type).toBe('json');
    const tables = block?.data as Array<{ name: string; columns: Array<{ name: string }> }>;
    expect(tables.map((x) => x.name).sort()).toEqual(['orders', 'users']);
    const users = tables.find((x) => x.name === 'users')!;
    expect(users.columns.map((c) => c.name).sort()).toEqual([
      'email',
      'id',
      'name',
      'password_hash',
    ]);
  });

  it('describe_table returns the columns for one table', async () => {
    const t = tools['sqlite.test.describe_table']!;
    const r = await t.handler({ name: 'users' }, ctx);
    const data = r.content[0]?.data as { name: string; columns: Array<{ name: string }> };
    expect(data.name).toBe('users');
    expect(data.columns.length).toBe(4);
  });

  it('describe_table errors on unknown table', async () => {
    const t = tools['sqlite.test.describe_table']!;
    await expect(t.handler({ name: 'does_not_exist' }, ctx)).rejects.toThrow(/not found/);
  });

  it('query runs a parameterized SELECT and returns rows', async () => {
    const t = tools['sqlite.test.query']!;
    const r = await t.handler(
      { sql: 'SELECT id, email FROM users WHERE id = ? ORDER BY id', params: [1] },
      ctx,
    );
    const data = r.content[0]?.data as {
      columns: string[];
      rows: Array<{ id: number; email: string }>;
      rowCount: number;
      truncated: boolean;
    };
    expect(data.columns).toEqual(['id', 'email']);
    expect(data.rows).toEqual([{ id: 1, email: 'alice@example.com' }]);
    expect(data.rowCount).toBe(1);
    expect(data.truncated).toBe(false);
  });

  it('query truncates results to rowCap and flips truncated flag', async () => {
    const t = tools['sqlite.test.query']!;
    const tightCtx: ToolExecCtx = { ...ctx, limits: { ...ctx.limits, rowCap: 2 } };
    const r = await t.handler({ sql: 'SELECT id FROM orders ORDER BY id' }, tightCtx);
    const data = r.content[0]?.data as { rows: unknown[]; rowCount: number; truncated: boolean };
    expect(data.rowCount).toBe(2);
    expect(data.truncated).toBe(true);
    expect(r.metadata?.truncated).toBe(true);
  });

  it('policy rejects writes before they reach the DB, with a reason', async () => {
    const t = tools['sqlite.test.query']!;
    await expect(
      t.handler({ sql: 'UPDATE users SET name = ? WHERE id = ?', params: ['Eve', 1] }, ctx),
    ).rejects.toMatchObject({
      code: 'forbidden.policy',
      message: expect.stringContaining('read-only'),
    });
  });

  it('policy rejects DDL with a reason', async () => {
    const t = tools['sqlite.test.query']!;
    await expect(t.handler({ sql: 'DROP TABLE users' }, ctx)).rejects.toMatchObject({
      code: 'forbidden.policy',
      message: expect.stringContaining('always blocked'),
    });
  });

  it('DB-level read-only still blocks a write the policy allows (defense in depth)', async () => {
    const c = new SqlConnector({
      id: 'sqlite.rw',
      dialect: new SqliteDialect(dbPath),
      policy: {
        tables: { users: 'write' },
        defaultAccess: 'read',
        denyColumns: [],
        maxWritesPerCall: 1,
      },
    });
    await c.init({ logger: ctx.logger });
    try {
      const q = c.listPrimitiveTools().find((x) => x.name === 'sqlite.rw.query')!;
      await expect(
        q.handler({ sql: "UPDATE users SET name = 'Eve' WHERE id = 1" }, ctx),
      ).rejects.toMatchObject({ code: 'forbidden.read_only' });
    } finally {
      await c.close();
    }
  });

  it('dryRun returns the decision without executing', async () => {
    const t = tools['sqlite.test.query']!;
    const r = await t.handler({ sql: 'DROP TABLE users', dryRun: true }, ctx);
    const data = r.content[0]?.data as {
      dryRun: boolean;
      decision: { allow: boolean; reason: string };
    };
    expect(data.dryRun).toBe(true);
    expect(data.decision.allow).toBe(false);
    // table still there
    const ok = await t.handler({ sql: 'SELECT count(*) AS n FROM users' }, ctx);
    expect((ok.content[0]?.data as { rows: Array<{ n: number }> }).rows[0]?.n).toBe(2);
  });

  it('policy hides denied columns and tables from list_tables and blocks querying them', async () => {
    const c = new SqlConnector({
      id: 'sqlite.p',
      dialect: new SqliteDialect(dbPath),
      policy: {
        tables: { orders: 'none' },
        defaultAccess: 'read',
        denyColumns: ['users.password_hash'],
        maxWritesPerCall: 1,
        maxRows: 1,
      },
    });
    await c.init({ logger: ctx.logger });
    try {
      const byName = Object.fromEntries(c.listPrimitiveTools().map((x) => [x.name, x]));
      const list = await byName['sqlite.p.list_tables']!.handler({}, ctx);
      const tables = list.content[0]?.data as Array<{ name: string; columns: { name: string }[] }>;
      expect(tables.map((x) => x.name)).toEqual(['users']);
      expect(tables[0]!.columns.map((x) => x.name)).not.toContain('password_hash');

      const q = byName['sqlite.p.query']!;
      await expect(
        q.handler({ sql: 'SELECT password_hash FROM users' }, ctx),
      ).rejects.toMatchObject({
        code: 'forbidden.policy',
      });
      await expect(q.handler({ sql: 'SELECT id FROM orders' }, ctx)).rejects.toMatchObject({
        code: 'forbidden.policy',
      });
      const r = await q.handler({ sql: 'SELECT email FROM users' }, ctx);
      expect((r.content[0]?.data as { rowCount: number }).rowCount).toBe(1); // maxRows
    } finally {
      await c.close();
    }
  });

  it('health() returns ok with a real latency reading', async () => {
    const h = await connector.health();
    expect(h.ok).toBe(true);
    expect(typeof h.latencyMs).toBe('number');
  });

  it('introspect() returns a sql snapshot', async () => {
    const snap = await connector.introspect();
    expect(snap.kind).toBe('sql');
    if (snap.kind !== 'sql') throw new Error('unexpected snapshot kind');
    expect(snap.tables.length).toBe(2);
  });
});
