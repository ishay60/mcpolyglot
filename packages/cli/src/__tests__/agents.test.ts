import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ConfigSchema, type McpolyglotConfig } from '@mcpolyglot/config';
import type { McpolyglotServer } from '@mcpolyglot/core';
import { hashToken, StreamableHttpTransport } from '@mcpolyglot/core/transports/streamable-http';
import { buildServerFromConfig } from '../factory.js';

// Real HTTP transport + real SQLite through the CLI factory: two agents, one source.
// better-sqlite3 is connector-sql's dependency; borrow it from there to seed the file.
const Database = createRequire(new URL('../../../connector-sql/package.json', import.meta.url))(
  'better-sqlite3',
) as new (path: string) => { exec(sql: string): void; close(): void };

const silent = { debug() {}, info() {}, warn() {}, error() {} };
let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcpolyglot-agents-'));
  dbPath = join(dir, 'app.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, total INTEGER);
    INSERT INTO users (email) VALUES ('a@x.io');
    INSERT INTO orders (total) VALUES (42);
  `);
  db.close();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let server: McpolyglotServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function boot(extra: Record<string, unknown>) {
  const auditPath = join(dir, `audit-${Math.random().toString(36).slice(2)}.jsonl`);
  const cfg: McpolyglotConfig = ConfigSchema.parse({
    sources: [
      {
        id: 'app',
        kind: 'sqlite',
        url: dbPath,
        scopes: ['schema:read', 'tables:read', 'query:raw'],
      },
    ],
    audit: { console: false, path: auditPath },
    ...extra,
  });
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

  const rpc = async (
    token: string,
    method: string,
    params: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = await res.text();
    if (res.status !== 200) return { status: res.status, body };
    const data = body.split('\n').find((l) => l.startsWith('data: '));
    return { status: res.status, body: JSON.parse(data ? data.slice(6) : body) };
  };
  const audit = () =>
    readFileSync(auditPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { rpc, audit };
}

const toolNames = (r: { body: { result: { tools: { name: string }[] } } }) =>
  r.body.result.tools.map((t) => t.name).sort();
const text = (r: { body: { result: { content: { text: string }[] } } }) =>
  r.body.result.content.map((c) => c.text).join('');

describe('multi-agent HTTP', () => {
  const agents = [
    {
      id: 'analyst',
      tokens: [{ hash: hashToken('tok-analyst') }],
      sources: { app: { policy: { tables: { users: 'none' } } } },
    },
    {
      id: 'browser',
      tokens: [{ hash: hashToken('tok-old'), revoked: true }, { hash: hashToken('tok-browser') }],
      scopes: ['schema:read'],
      sources: { app: {} },
    },
  ];

  it('filters tools per agent scopes and applies each agent its own policy', async () => {
    const { rpc } = await boot({ agents });

    expect(toolNames(await rpc('tok-analyst', 'tools/list'))).toEqual([
      'app.describe_table',
      'app.list_tables',
      'app.query',
    ]);
    // `browser` lacks query:raw/tables:read, so `app.query` doesn't exist for it.
    expect(toolNames(await rpc('tok-browser', 'tools/list'))).toEqual([
      'app.describe_table',
      'app.list_tables',
    ]);
    const call = { name: 'app.query', arguments: { sql: 'SELECT email FROM users' } };
    expect((await rpc('tok-browser', 'tools/call', call)).body.error.message).toMatch(
      /Unknown tool/,
    );

    // Same table, same DB: analyst's policy hides `users`, the source default doesn't.
    const denied = await rpc('tok-analyst', 'tools/call', call);
    expect(denied.body.result.isError).toBe(true);
    expect(text(denied)).toMatch(/forbidden\.policy/);
    const listA = text(
      await rpc('tok-analyst', 'tools/call', { name: 'app.list_tables', arguments: {} }),
    );
    const listB = text(
      await rpc('tok-browser', 'tools/call', { name: 'app.list_tables', arguments: {} }),
    );
    expect(listA).not.toMatch(/"users"/);
    expect(listB).toMatch(/"users"/);
    const orders = await rpc('tok-analyst', 'tools/call', {
      name: 'app.query',
      arguments: { sql: 'SELECT total FROM orders' },
    });
    expect(text(orders)).toMatch(/42/);
  });

  it("an agent's policy can narrow the source policy but never widen it", async () => {
    const { rpc } = await boot({
      sources: [
        {
          id: 'app',
          kind: 'sqlite',
          url: dbPath,
          scopes: ['schema:read', 'tables:read', 'query:raw'],
          policy: { tables: { users: 'none' } },
        },
      ],
      agents: [
        {
          id: 'sneaky',
          tokens: [{ hash: hashToken('tok-sneaky') }],
          sources: { app: { policy: { tables: { users: 'write' }, defaultAccess: 'read' } } },
        },
      ],
    });
    const r = await rpc('tok-sneaky', 'tools/call', {
      name: 'app.query',
      arguments: { sql: 'SELECT email FROM users' },
    });
    expect(text(r)).toMatch(/forbidden\.policy/);
    // Widening to `write` must not register the write tool either.
    expect(toolNames(await rpc('tok-sneaky', 'tools/list'))).not.toContain('app.execute');
  });

  it('rejects revoked and unknown tokens with 401', async () => {
    const { rpc } = await boot({ agents });
    expect((await rpc('tok-old', 'tools/list')).status).toBe(401);
    expect((await rpc('shared', 'tools/list')).status).toBe(401);
  });

  it('audit agentId comes from the token, not the header', async () => {
    const { rpc, audit } = await boot({ agents });
    await rpc(
      'tok-browser',
      'tools/call',
      { name: 'app.list_tables', arguments: {} },
      { 'x-mcpolyglot-agent': 'analyst' },
    );
    const [entry] = audit();
    expect(entry!.agentId).toBe('browser');
    expect(entry!.scopes).toEqual(['schema:read']);
    expect(JSON.stringify(audit())).not.toMatch(/tok-/);
  });

  it('without `agents`: shared token, all tools, header-labelled audit (unchanged)', async () => {
    const { rpc, audit } = await boot({});
    expect(toolNames(await rpc('shared', 'tools/list'))).toHaveLength(3);
    const r = await rpc(
      'shared',
      'tools/call',
      { name: 'app.query', arguments: { sql: 'SELECT email FROM users' } },
      { 'x-mcpolyglot-agent': 'whoever' },
    );
    expect(text(r)).toMatch(/"rowCount": 1/);
    expect(audit()[0]!.agentId).toBe('whoever');
  });
});
