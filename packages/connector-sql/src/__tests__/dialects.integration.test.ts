import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolDefinition, ToolExecCtx } from '@mcpolyglot/core';
import { SqlConnector } from '../connector.js';
import type { SqlDialect } from '../dialect.js';
import { PostgresDialect } from '../dialects/postgres.js';
import { MysqlDialect } from '../dialects/mysql.js';
import type { Policy } from '../policy.js';

// Real servers, same assertions for each dialect. Each block runs only when its URL is set
// (CI sets both via service containers):
//   PG_TEST_URL=postgres://postgres:test@localhost:55432/postgres
//   MYSQL_TEST_URL=mysql://root:test@localhost:53306/test

const SEED = [
  'DROP TABLE IF EXISTS orders',
  'DROP TABLE IF EXISTS users',
  'CREATE TABLE users (id INT PRIMARY KEY, email VARCHAR(100), password_hash VARCHAR(100))',
  'CREATE TABLE orders (id INT PRIMARY KEY, user_id INT, total_cents INT)',
  "INSERT INTO users VALUES (1, 'alice@example.com', 'h1'), (2, 'bob@example.com', 'h2')",
  'INSERT INTO orders VALUES (1, 1, 4995), (2, 1, 12000), (3, 2, 2500)',
];

interface Target {
  name: string;
  url: string | undefined;
  make: (url: string) => SqlDialect;
  seed: (url: string) => Promise<void>;
  param: string; // placeholder for the first bind param
  sleep: string; // a query that takes ~3s
}

const targets: Target[] = [
  {
    name: 'postgres',
    url: process.env.PG_TEST_URL,
    make: (u) => new PostgresDialect(u),
    param: '$1',
    sleep: 'SELECT pg_sleep(3)',
    seed: async (u) => {
      const { Client } = await import('pg');
      const c = new Client({ connectionString: u });
      await c.connect();
      for (const s of SEED) await c.query(s);
      await c.end();
    },
  },
  {
    name: 'mysql',
    url: process.env.MYSQL_TEST_URL,
    make: (u) => new MysqlDialect(u),
    param: '?',
    sleep: 'SELECT SLEEP(3) AS s',
    seed: async (u) => {
      const mysql = await import('mysql2/promise');
      const c = await mysql.createConnection(u);
      for (const s of SEED) await c.query(s);
      await c.end();
    },
  },
];

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const ctx: ToolExecCtx = {
  sessionId: 't',
  scopes: new Set(['schema:read', 'tables:read', 'query:raw']),
  signal: new AbortController().signal,
  limits: { rowCap: 100, timeoutMs: 5_000, maxBytes: 256 * 1024 },
  logger,
};

for (const t of targets) {
  describe.skipIf(!t.url)(`${t.name} end-to-end`, () => {
    const connectors: SqlConnector[] = [];

    async function open(policy?: Policy) {
      const c = new SqlConnector({
        id: t.name,
        dialect: t.make(t.url!),
        ...(policy && { policy }),
      });
      await c.init({ logger });
      connectors.push(c);
      const tools: Record<string, ToolDefinition> = Object.fromEntries(
        c.listPrimitiveTools().map((x) => [x.name.slice(t.name.length + 1), x]),
      );
      return tools;
    }

    beforeAll(async () => {
      await t.seed(t.url!);
    });
    afterAll(async () => {
      for (const c of connectors) await c.close();
    });

    it('reads with bind params', async () => {
      const { query } = await open();
      const r = await query!.handler(
        { sql: `SELECT id FROM orders WHERE user_id = ${t.param} ORDER BY id`, params: [1] },
        ctx,
      );
      expect((r.content[0]!.data as { rows: unknown[] }).rows).toHaveLength(2);
    });

    it('caps rows and flags truncation', async () => {
      const { query } = await open();
      const r = await query!.handler(
        { sql: 'SELECT id FROM orders' },
        { ...ctx, limits: { ...ctx.limits, rowCap: 2 } },
      );
      expect(r.metadata).toMatchObject({ rows: 2, truncated: true });
    });

    it('policy denies DDL and writes before the DB sees them', async () => {
      const { query } = await open();
      for (const sql of ['DROP TABLE users', "UPDATE users SET email = 'x' WHERE id = 1"]) {
        await expect(query!.handler({ sql }, ctx)).rejects.toMatchObject({
          code: 'forbidden.policy',
        });
      }
    });

    // Postgres: BEGIN READ ONLY rejects it. MySQL: the dialect's own AST gate rejects it first.
    it('dialect read-only layer blocks a write the policy allowed', async () => {
      const { query } = await open({
        tables: { users: 'write' },
        defaultAccess: 'read',
        denyColumns: [],
        maxWritesPerCall: 1,
      });
      await expect(
        query!.handler({ sql: "UPDATE users SET email = 'pwned' WHERE id = 1" }, ctx),
      ).rejects.toMatchObject({ code: 'forbidden.read_only' });
      const check = await (
        await open()
      ).query!.handler({ sql: 'SELECT email FROM users WHERE id = 1' }, ctx);
      expect((check.content[0]!.data as { rows: Array<{ email: string }> }).rows[0]!.email).toBe(
        'alice@example.com',
      );
    });

    it('denied columns are blocked in queries and hidden from list_tables', async () => {
      const tools = await open({
        tables: {},
        defaultAccess: 'read',
        denyColumns: ['users.password_hash'],
        maxWritesPerCall: 1,
      });
      await expect(
        tools.query!.handler({ sql: 'SELECT password_hash FROM users' }, ctx),
      ).rejects.toMatchObject({ code: 'forbidden.policy' });
      const list = await tools.list_tables!.handler({}, ctx);
      const users = (
        list.content[0]!.data as Array<{ name: string; columns: { name: string }[] }>
      ).find((x) => x.name === 'users')!;
      expect(users.columns.map((c) => c.name)).toEqual(['id', 'email']);
    });

    it('the DB enforces the statement timeout', async () => {
      const { query } = await open();
      const t0 = Date.now();
      await query!
        .handler({ sql: t.sleep }, { ...ctx, limits: { ...ctx.limits, timeoutMs: 300 } })
        .catch(() => {}); // pg errors; MySQL's SLEEP returns early instead
      expect(Date.now() - t0).toBeLessThan(2_000);
    });
  });
}
