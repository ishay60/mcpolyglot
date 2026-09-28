import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpolyglotServer, type AuditEntry } from '../server.js';
import type { Connector } from '../connector.js';
import type { Transport } from '../transport.js';
import { McpolyglotError } from '../errors.js';

const SECRET_ARG = 'super-secret-arg-value';

function fakeConnector(): Connector {
  return {
    id: 'fake',
    kind: 'sql',
    init: async () => {},
    close: async () => {},
    health: async () => ({ ok: true, latencyMs: 0 }),
    introspect: async () => ({ kind: 'sql', tables: [] }),
    generatePerEntityTools: () => [],
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

async function boot() {
  const entries: AuditEntry[] = [];
  const passthrough = (_: string, r: never) => r;
  const server = new McpolyglotServer({
    connectors: [fakeConnector()],
    security: {
      hooks: {
        checkScopes: () => {},
        checkRateLimit: async () => {},
        redact: (_t, result) => ({ result, redactionsApplied: 0 }),
        enforceSize: passthrough,
        wrapUntrusted: (r) => r,
        audit: async (e) => {
          entries.push(e);
        },
      },
      defaultLimits: { rowCap: 10, timeoutMs: 5_000, maxBytes: 65_536 },
      defaultScopes: [],
    },
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const transport: Transport = {
    kind: 'stdio',
    start: (s) => s.connect(serverSide),
    stop: async () => {},
  };
  await server.start(transport);
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(clientSide);
  return { client, entries, server };
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
