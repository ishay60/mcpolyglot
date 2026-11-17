import { describe, expect, it } from 'vitest';
import type { ConnectorInitCtx } from '@mcpolyglot/core';
import { PriorityConnector, EntityPolicySchema } from '../index.js';

const noop = () => {};
const initCtx: ConnectorInitCtx = { logger: { debug: noop, info: noop, warn: noop, error: noop } };
const base = {
  id: 'prio',
  serviceRoot: 'https://priority.test/odata/Priority/tabula.ini/demo',
  auth: { type: 'pat' as const, token: 'test-token' },
};

// What the scaffold already guarantees (fail-closed defaults). These pass today.
describe('scaffold', () => {
  it('registers only read tools, with read scopes and readOnly: true', () => {
    const tools = new PriorityConnector(base).listPrimitiveTools();
    expect(tools.map((t) => t.name)).toEqual([
      'prio.list_entities',
      'prio.describe_entity',
      'prio.query',
      'prio.get_record',
    ]);
    for (const t of tools) {
      expect(t.readOnly).toBe(true);
      expect(t.scopes.every((s) => s === 'schema:read' || s === 'tables:read')).toBe(true);
    }
  });

  it('registers no write tool even when the policy marks an entity write', () => {
    const c = new PriorityConnector({ ...base, policy: { entities: { ORDERS: 'write' } } });
    expect(c.listPrimitiveTools().some((t) => !t.readOnly)).toBe(false);
  });

  it('write tool contracts need tables:write and offer no delete or approve tool', () => {
    const names = new PriorityConnector(base).writeToolDefinitions().map((t) => t.name);
    expect(names).toEqual(['prio.create_record', 'prio.update_record', 'prio.approval_status']);
    expect(names.some((n) => /delete|approve|batch/.test(n.replace('approval_status', '')))).toBe(
      false,
    );
  });

  it('policy defaults hide every entity and never default to write', () => {
    const p = EntityPolicySchema.parse({});
    expect(p.defaultAccess).toBe('none');
    expect(() => EntityPolicySchema.parse({ defaultAccess: 'write' })).toThrow();
  });

  it('refuses an upstream budget above the documented tenant limit', async () => {
    const c = new PriorityConnector({ ...base, upstream: { callsPerMinute: 101 } });
    await expect(c.init(initCtx)).rejects.toThrow(/tenant limit/);
  });

  it('query input rejects raw OData and unknown keys', () => {
    const q = new PriorityConnector(base).readTools().find((t) => t.name === 'prio.query')!;
    expect(() => q.inputSchema.parse({ entity: 'ORDERS', $filter: "CUSTNAME eq '1'" })).toThrow();
    expect(() => q.inputSchema.parse({ entity: 'ORDERS; DROP' })).toThrow();
  });
});

// Every guarantee the finished connector must make. Each `todo` becomes a real test in the step
// that implements it (docs/enterprise-connector-plan.md), plus a row in SECURITY.md's
// claim -> test table. CI's integration job fails on *skipped* tests; `it.todo` is counted
// separately (numTodoTests) — see the plan's "CI note".
describe('policy (allow-list)', () => {
  it.todo('an entity not listed is hidden from list_entities and refused by every tool');
  it.todo('an entity marked none is refused with forbidden.policy and a readable reason');
  it.todo('entity names match case-sensitively (customers is not CUSTOMERS)');
  it.todo('a denied field is refused in select, filter, orderBy and write payloads');
  it.todo('a denied field is stripped from results, including expanded subforms');
  it.todo('expanding a subform whose access is none is refused');
  it.todo('a per-agent policy only narrows the source policy (entities, fields, caps)');
});

describe('write tools', () => {
  it.todo('write tools are registered only with a write entity AND an approval store');
  it.todo('a write to an entity that is read or none is refused before any request');
  it.todo(
    'records per write (parent + subform lines) above maxWritesPerCall are refused before sending',
  );
  it.todo('no delete and no $batch request is ever sent');
});

describe('human approval', () => {
  it.todo('a write returns pending with an approval id and sends nothing to Priority');
  it.todo('no MCP tool can approve or reject a write');
  it.todo('an approved write executes exactly the stored payload (hash checked before sending)');
  it.todo('a pending approval survives a restart and can be approved afterwards');
  it.todo('a write approved before a crash executes once after restart, never twice');
  it.todo('an expired or rejected approval never executes');
  it.todo("an agent cannot read or resume another agent's approval");
});

describe('upstream limits and pagination', () => {
  it.todo('all agents and tools of one source share one per-tenant call budget');
  it.todo('in-flight requests to Priority never exceed upstream.maxInFlight');
  it.todo('a 429 from Priority becomes rate_limited and is not retried');
  it.todo('after a 401 the source stops calling Priority (login lock: 3 failures / 10 min)');
  it.todo('top is capped at min(policy.maxRecordsPerCall, source rowCap)');
  it.todo('nextCursor is returned only when more records exist, and a tampered cursor is refused');
  it.todo('requests never leave the service root; keys with quotes or .. are escaped or refused');
  it.todo('filters are built into $filter with values escaped; no raw OData from the model');
});

describe('audit', () => {
  it.todo('every call, allowed or denied, produces one audit line with agent, tool, decision');
  it.todo('audit detail names entity and operation; never field values or the PAT');
  it.todo('approval requests, decisions and executions are each audited');
});

describe('auth', () => {
  it.todo("the agent's inbound token is never forwarded to Priority");
  it.todo('the PAT is sent as Basic <PAT>:PAT and never appears in logs, errors or results');
});
