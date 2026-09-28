import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpolyglotServer } from '@mcpolyglot/core';
import { StreamableHttpTransport } from '@mcpolyglot/core/transports/streamable-http';
import { SqlConnector, SqliteDialect } from '@mcpolyglot/connector-sql';
import { defaultSecurityHooks } from '@mcpolyglot/security';
import { McpolyglotClient, McpolyglotDeniedError } from '../index.js';

let canRun = true;
try {
  await import('better-sqlite3');
} catch {
  canRun = false;
}
const d = canRun ? describe : describe.skip;

d('McpolyglotClient over Streamable HTTP', () => {
  let dir: string;
  let server: McpolyglotServer;
  let client: McpolyglotClient;
  let baseUrl: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcpolyglot-client-'));
    const dbPath = join(dir, 'bank.db');
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE accounts (id INTEGER PRIMARY KEY, owner TEXT, balance INTEGER, api_key TEXT);
      CREATE TABLE audit_notes (id INTEGER PRIMARY KEY, note TEXT);
      INSERT INTO accounts (owner, balance, api_key) VALUES ('Ada', 100, 'k1'), ('Lin', 250, 'k2');
    `);
    db.close();

    const connector = new SqlConnector({
      id: 'bank',
      dialect: new SqliteDialect(dbPath),
      policy: {
        tables: { accounts: 'read' },
        defaultAccess: 'none',
        denyColumns: ['accounts.api_key'],
        maxWritesPerCall: 1,
      },
    });
    server = new McpolyglotServer({
      connectors: [connector],
      scopes: ['schema:read', 'tables:read', 'query:raw'],
      security: {
        hooks: defaultSecurityHooks({ audit: { console: false } }),
        defaultLimits: { rowCap: 100, timeoutMs: 5_000, maxBytes: 256 * 1024 },
        defaultScopes: ['schema:read', 'tables:read', 'query:raw'],
      },
    });
    const transport = new StreamableHttpTransport({
      host: '127.0.0.1',
      port: 0,
      auth: { kind: 'bearer', token: 'test-token' },
      logger: { info: () => {}, warn: () => {} },
    });
    await server.start(transport);
    const port = (
      transport as unknown as { httpServer: { address(): { port: number } } }
    ).httpServer.address().port;
    baseUrl = `http://127.0.0.1:${port}/mcp`;
    client = await McpolyglotClient.connect(baseUrl, { token: 'test-token', agentId: 'sdk-test' });
  });

  afterAll(async () => {
    await client?.close();
    await server?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists only the tables and columns the policy exposes', async () => {
    const tables = await client.listTables('bank');
    expect(tables.map((t) => t.name)).toEqual(['accounts']);
    expect(tables[0]!.columns.map((c) => c.name)).toEqual(['id', 'owner', 'balance']);
  });

  it('runs a parameterized query and returns typed rows', async () => {
    const res = await client.query<{ owner: string; balance: number }>(
      'bank',
      'SELECT owner, balance FROM accounts WHERE balance > ? ORDER BY id',
      [50],
    );
    expect(res.rowCount).toBe(2);
    expect(res.rows).toEqual([
      { owner: 'Ada', balance: 100 },
      { owner: 'Lin', balance: 250 },
    ]);
  });

  it('returns the policy decision on dryRun without executing', async () => {
    const res = await client.query('bank', 'SELECT note FROM audit_notes', undefined, {
      dryRun: true,
    });
    expect(res.dryRun).toBe(true);
    expect(res.decision.allow).toBe(false);
  });

  it('surfaces a policy denial as McpolyglotDeniedError with code and reason', async () => {
    const err = await client
      .query('bank', 'SELECT owner, api_key FROM accounts')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpolyglotDeniedError);
    expect((err as McpolyglotDeniedError).code).toBe('forbidden.policy');
    expect((err as McpolyglotDeniedError).reason).toMatch(/denied column "accounts.api_key"/);
  });

  it('rejects a wrong bearer token at connect time', async () => {
    await expect(McpolyglotClient.connect(baseUrl, { token: 'nope' })).rejects.toThrow();
  });
});
