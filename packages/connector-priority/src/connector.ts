import { z } from 'zod';
import type { Connector, ConnectorInitCtx, ToolDefinition } from '@mcpolyglot/core';
import { McpolyglotError } from '@mcpolyglot/core';
import { EntityPolicySchema, type EntityPolicy } from './policy.js';
import { PRIORITY_DOCUMENTED_LIMITS, type UpstreamLimits } from './limits.js';
import type { PriorityAppLicense, PriorityAuth, PriorityClient } from './client.js';
import type { ApprovalPolicy, ApprovalStore } from './approval.js';

export interface PriorityConnectorOptions {
  /** Source id; tools are named `<id>.<verb>`. */
  id: string;
  /** `https://<host>/odata/Priority/<tabula.ini>/<company>`. One company per source. */
  serviceRoot: string;
  /** Upstream credential, already resolved from `${env:...}` by the CLI factory. */
  auth: PriorityAuth;
  appLicense?: PriorityAppLicense;
  /** Allow-list. Parsed with `EntityPolicySchema`; omitted = every entity hidden. */
  policy?: z.input<typeof EntityPolicySchema>;
  /** Defaults to the documented per-tenant limits. Set lower if other integrations share the tenant. */
  upstream?: Partial<UpstreamLimits>;
  /** Required before any write tool is registered. See approval.ts. */
  approval?: { policy: ApprovalPolicy; store: ApprovalStore };
  /** For tests: a fake client instead of HTTP. */
  client?: PriorityClient;
}

/** Entity / field names as Priority spells them. */
const Name = z.string().regex(/^[A-Za-z0-9_]+$/);
const Scalar = z.union([z.string(), z.number(), z.boolean()]);
const Key = z.record(Name, z.union([z.string(), z.number()])).describe('Key fields -> values');

/** Structured filters only: the model never writes raw `$filter`, so every field is checkable. */
const FilterSchema = z
  .object({
    field: Name,
    op: z.enum(['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'startswith', 'contains']),
    value: Scalar,
  })
  .strict();

function notImplemented(tool: string): never {
  throw new McpolyglotError('not_implemented', `${tool} is not implemented yet (scaffold)`);
}

/**
 * Priority ERP over its REST (OData) API.
 *
 * Read tools first; write tools only for entities the policy marks `write`, and only behind
 * human approval. The pipeline in `McpolyglotServer.executeTool` still wraps every tool here
 * (scope, rate limit, timeout, redact, size cap, untrusted-wrap, audit); this class adds what
 * only a Priority connector can know: which entities and fields exist, the per-tenant budget,
 * and what a write costs.
 */
export class PriorityConnector implements Connector {
  readonly id: string;
  // TODO(ishay): decision D3. `ConnectorKind` in core is 'sql' | 'mongo' | 'openapi'. It is only
  // displayed (serve banner, doctor). Adding 'priority' is a one-line core change; until then
  // this reuses 'openapi', the nearest existing kind (HTTP API, not a database).
  readonly kind = 'openapi' as const;
  private readonly policy: EntityPolicy;
  private readonly upstream: UpstreamLimits;
  private readonly opts: PriorityConnectorOptions;

  constructor(opts: PriorityConnectorOptions) {
    this.id = opts.id;
    this.opts = opts;
    this.policy = EntityPolicySchema.parse(opts.policy ?? {});
    this.upstream = {
      callsPerMinute: PRIORITY_DOCUMENTED_LIMITS.callsPerMinutePerTenant,
      maxInFlight: PRIORITY_DOCUMENTED_LIMITS.maxInFlight,
      ...opts.upstream,
    };
  }

  /**
   * TODO(ishay): build the HttpPriorityClient (unless `opts.client` is given), then call
   * `priorityVersion()` and `loginName()` once so a bad PAT fails at startup. Careful: three
   * 401s in 10 minutes lock the Priority user for 30 minutes (26.1+), so never retry here.
   */
  async init(_ctx: ConnectorInitCtx): Promise<void> {
    if (this.upstream.callsPerMinute > PRIORITY_DOCUMENTED_LIMITS.callsPerMinutePerTenant) {
      throw new McpolyglotError(
        'config.invalid',
        `${this.id}: upstream.callsPerMinute exceeds Priority's documented tenant limit`,
      );
    }
  }

  async close(): Promise<void> {}

  /** TODO(ishay): `GetPriorityVersion()` with a short timeout; report version in `details`. */
  async health(): Promise<{ ok: boolean; latencyMs: number; details?: string }> {
    return { ok: false, latencyMs: 0, details: 'scaffold: health not implemented' };
  }

  /**
   * TODO(ishay): `doctor` findings. Facts: Priority version, login name, readable / writable /
   * hidden entities, whether approval is on. Problems: a policy entity the API doesn't expose,
   * a denied field that doesn't exist, writes configured without an approval store.
   */
  // diagnose?(): Promise<ConnectorDiagnosis>

  /** The parsed allow-list this source enforces. */
  get entityPolicy(): EntityPolicy {
    return this.policy;
  }

  listPrimitiveTools(): ToolDefinition[] {
    return [...this.readTools(), ...this.writeToolsIfAllowed()];
  }

  /** Read tools. Always registered; the policy decides what they can see. */
  readTools(): ToolDefinition[] {
    const id = this.id;
    return [
      {
        name: `${id}.list_entities`,
        description: `List the ${id} Priority entities (forms) this agent may read or write.`,
        inputSchema: z.object({}).strict(),
        scopes: ['schema:read'],
        readOnly: true,
        // TODO(ishay): service root entity sets ∩ policy; hidden entities must not be listed.
        handler: async () => notImplemented(`${id}.list_entities`),
      },
      {
        name: `${id}.describe_entity`,
        description: `Fields, key fields and subforms of one ${id} entity. Denied fields are not shown.`,
        inputSchema: z.object({ entity: Name }).strict(),
        scopes: ['schema:read'],
        readOnly: true,
        handler: async () => notImplemented(`${id}.describe_entity`),
      },
      {
        name: `${id}.query`,
        description:
          `Read records from one ${id} entity with structured filters, field selection and ` +
          `ordering. Returns at most \`top\` records and a \`nextCursor\` when there are more.`,
        inputSchema: z
          .object({
            entity: Name,
            select: z.array(Name).optional(),
            filter: z.array(FilterSchema).default([]),
            orderBy: z
              .array(z.object({ field: Name, desc: z.boolean().default(false) }).strict())
              .default([]),
            top: z
              .number()
              .int()
              .positive()
              .max(PRIORITY_DOCUMENTED_LIMITS.defaultMaxApiLines)
              .optional(),
            cursor: z.string().optional().describe('nextCursor from the previous page'),
            expand: z
              .array(Name)
              .default([])
              .describe('Subforms to include, e.g. ORDERITEMS_SUBFORM'),
          })
          .strict(),
        scopes: ['tables:read'],
        readOnly: true,
        // TODO(ishay): checkRead -> cap top to min(policy, ctx.limits.rowCap) -> decode cursor
        // (signed or at least validated, so it can't point at another entity) -> client.query
        // -> strip denied fields -> { records, nextCursor } with metadata.rows.
        handler: async () => notImplemented(`${id}.query`),
      },
      {
        name: `${id}.get_record`,
        description: `Read one ${id} record by its key fields.`,
        inputSchema: z
          .object({ entity: Name, key: Key, expand: z.array(Name).default([]) })
          .strict(),
        scopes: ['tables:read'],
        readOnly: true,
        handler: async () => notImplemented(`${id}.get_record`),
      },
    ];
  }

  /**
   * Write tools, as they will be defined. Not registered by this scaffold (see below); exposed so
   * tests and docs can inspect the contract.
   */
  writeToolDefinitions(): ToolDefinition[] {
    const id = this.id;
    const Fields = z.record(Name, Scalar.nullable()).describe('Field -> value');
    return [
      {
        name: `${id}.create_record`,
        description:
          `Request a new ${id} record. Needs human approval: the call returns an approval id, ` +
          `and nothing is written until a person approves it.`,
        inputSchema: z
          .object({
            entity: Name,
            fields: Fields,
            subforms: z.record(Name, z.array(Fields)).default({}),
          })
          .strict(),
        scopes: ['tables:write'],
        readOnly: false,
        // TODO(ishay): checkWrite -> store PendingApproval -> return "pending" tool result.
        handler: async () => notImplemented(`${id}.create_record`),
      },
      {
        name: `${id}.update_record`,
        description: `Request a change to one ${id} record by key. Needs human approval.`,
        inputSchema: z.object({ entity: Name, key: Key, fields: Fields }).strict(),
        scopes: ['tables:write'],
        readOnly: false,
        handler: async () => notImplemented(`${id}.update_record`),
      },
      {
        name: `${id}.approval_status`,
        description: `State of one of this agent's pending ${id} writes: pending, approved, rejected, executed, failed or expired.`,
        inputSchema: z.object({ approvalId: z.string().min(1) }).strict(),
        scopes: ['tables:write'],
        // Not read-only if it is also what executes an approved write (decision D6).
        readOnly: false,
        // TODO(ishay): an agent may only see its own approvals (compare agentId).
        handler: async () => notImplemented(`${id}.approval_status`),
      },
      // Deliberately absent: delete, $batch (no rollback, up to 100 ops), and any tool that
      // approves a write. Approval happens outside MCP, or the agent can approve itself.
    ];
  }

  /**
   * TODO(ishay): return `writeToolDefinitions()` only when at least one entity is `write` AND
   * `opts.approval` is configured. Until that rule is implemented and tested, register none:
   * fail closed.
   */
  private writeToolsIfAllowed(): ToolDefinition[] {
    void this.opts.approval;
    return [];
  }
}
