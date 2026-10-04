import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpolyglotServer, type AuditEntry } from '../server.js';
import type { Connector } from '../connector.js';
import type { ToolExecLimits } from '../tool.js';
import type { Transport } from '../transport.js';
import { McpolyglotError } from '../errors.js';

const SECRET_ARG = 'super-secret-arg-value';

let handlerCalls = 0;

function fakeConnector(): Connector {
  return {
    id: 'fake',
    kind: 'sql',
    init: async () => {},
    close: async () => {},
    health: async () => ({ ok: true, latencyMs: 0 }),
    listPrimitiveTools: () => [
      {
        name: 'fake.ok',
        description: 'ok',
        inputSchema: z.object({ q: z.string() }),
        scopes: [],
        readOnly: true,
        handler: async () => ({
          content: [{ type: 'json', data: [{ secret_row: 'row-data' }] }],
          metadata: { rows: 1 },
        }),
      },
      {
        name: 'fake.denied',
        description: 'denied',
        inputSchema: z.object({ q: z.string() }),
        scopes: [],
        readOnly: true,
        handler: async () => {
          throw new McpolyglotError('forbidden.policy', 'Table "x" is not accessible.');
        },
      },
      {
        name: 'fake.scoped',
        description: 'needs a scope nobody has',
        inputSchema: z.object({}),
        scopes: ['tables:write'],
        readOnly: false,
        handler: async () => {
          handlerCalls += 1;
          return { content: [] };
        },
      },
      {
        name: 'fake.slow',
        description: 'ignores the abort signal and never returns in time',
        inputSchema: z.object({}),
        scopes: [],
        readOnly: true,
        handler: () => new Promise(() => {}),
      },
      {
        name: 'fake.broken',
        description: 'broken',
        inputSchema: z.object({ q: z.string() }),
        scopes: [],
        readOnly: true,
        handler: async () => {
          throw new Error('boom');
        },
      },
    ],
  } as unknown as Connector;
}

async function boot(opts: { timeoutMs?: number; limits?: Record<string, ToolExecLimits> } = {}) {
  const entries: AuditEntry[] = [];
  const rate = { taken: 0, released: 0 };
  const passthrough = (_: string, r: never) => r;
  const server = new McpolyglotServer({
    connectors: [fakeConnector()],
    security: {
      hooks: {
        checkScopes: (_name, required, granted) => {
          const missing = required.filter((s) => !granted.has(s));
          if (missing.length) throw new McpolyglotError('forbidden.scope', `missing ${missing}`);
        },
        checkRateLimit: async () => {
          rate.taken += 1;
          return () => {
            rate.released += 1;
          };
        },
        redact: (_t, result) => ({ result, redactionsApplied: 0 }),
        enforceSize: passthrough,
        wrapUntrusted: (r) => r,
        audit: async (e) => {
          entries.push(e);
        },
      },
      defaultLimits: { rowCap: 10, timeoutMs: opts.timeoutMs ?? 5_000, maxBytes: 65_536 },
      ...(opts.limits ? { limits: opts.limits } : {}),
      defaultScopes: [],
    },
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const transport: Transport = {
    kind: 'stdio',
    start: (create) => create().connect(serverSide),
    stop: async () => {},
  };
  await server.start(transport);
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(clientSide);
  return { client, entries, server, rate };
}

describe('audit entries', () => {
  it('records allow / deny / error with agent id, reason, rows, latency — never raw args or rows', async () => {
    const { client, entries, server } = await boot();
    await client.callTool({ name: 'fake.ok', arguments: { q: SECRET_ARG } });
    await client.callTool({ name: 'fake.denied', arguments: { q: SECRET_ARG } });
    await client.callTool({ name: 'fake.broken', arguments: { q: SECRET_ARG } }).catch(() => {});

    expect(entries.map((e) => [e.tool, e.decision])).toEqual([
      ['fake.ok', 'allow'],
      ['fake.denied', 'deny'],
      ['fake.broken', 'error'],
    ]);
    for (const e of entries) {
      expect(e.agentId).toBe('test-agent');
      expect(e.argsHash).toMatch(/^[0-9a-f]{16}$/);
      expect(typeof e.durationMs).toBe('number');
      expect(Date.parse(e.ts)).not.toBeNaN();
    }
    expect(entries[0]!.rows).toBe(1);
    expect(entries[0]!.reason).toBeUndefined();
    expect(entries[1]!.reason).toContain('not accessible');
    expect(entries[2]!.reason).toBe('boom');

    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(SECRET_ARG);
    expect(serialized).not.toContain('row-data');
    await server.stop();
  });

  it('same args → same hash; different args → different hash', async () => {
    const { client, entries, server } = await boot();
    await client.callTool({ name: 'fake.ok', arguments: { q: 'a' } });
    await client.callTool({ name: 'fake.ok', arguments: { q: 'a' } });
    await client.callTool({ name: 'fake.ok', arguments: { q: 'b' } });
    expect(entries[0]!.argsHash).toBe(entries[1]!.argsHash);
    expect(entries[0]!.argsHash).not.toBe(entries[2]!.argsHash);
    await server.stop();
  });
});

describe('pipeline guarantees', () => {
  it('scope check rejects before the handler runs', async () => {
    const { client, entries, server } = await boot();
    handlerCalls = 0;
    const r = await client.callTool({ name: 'fake.scoped', arguments: {} });
    expect(r.isError).toBe(true);
    expect(handlerCalls).toBe(0);
    expect(entries[0]).toMatchObject({ decision: 'deny', error: { code: 'forbidden.scope' } });
    await server.stop();
  });

  it('a handler that never returns is cut off at the timeout', async () => {
    const { client, entries, server } = await boot({ timeoutMs: 100 });
    const t0 = Date.now();
    const r = await client.callTool({ name: 'fake.slow', arguments: {} });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(r.isError).toBe(true);
    expect(entries[0]).toMatchObject({ decision: 'deny', error: { code: 'timeout' } });
    await server.stop();
  });

  it('releases the rate-limit slot on success, deny, timeout and error', async () => {
    const { client, server, rate } = await boot({ timeoutMs: 100 });
    for (const name of ['fake.ok', 'fake.denied', 'fake.slow', 'fake.broken']) {
      await client
        .callTool({ name, arguments: name === 'fake.slow' ? {} : { q: 'x' } })
        .catch(() => {});
    }
    expect(rate).toEqual({ taken: 4, released: 4 });
    await server.stop();
  });
});

describe('per-connector limits', () => {
  it("runs a tool under its own connector's limits, not the default", async () => {
    // The default allows 5s; the connector's own limit is 50ms, so the slow tool must time out.
    const { client, entries, server } = await boot({
      limits: { fake: { rowCap: 1, timeoutMs: 50, maxBytes: 65_536 } },
    });
    const started = Date.now();
    await client.callTool({ name: 'fake.slow', arguments: {} }).catch(() => {});
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(entries.at(-1)?.error?.code).toBe('timeout');
    await server.stop();
  });
});
