import { z } from 'zod';
import type {
  Connector,
  ConnectorInitCtx,
  PerEntityConfig,
  SchemaSnapshot,
  TableSchema,
  ToolDefinition,
} from '@mcpolyglot/core';
import { McpolyglotError, RateLimitError } from '@mcpolyglot/core';
import type { SqlDialect } from './dialect.js';
import { classify, isColumnDenied, PolicySchema, tableAccess, type Policy } from './policy.js';

export type SqlDialectKind = SqlDialect['kind'];

export interface SqlConnectorOptions {
  id: string;
  dialect: SqlDialect;
  /** Access policy. Omitted = every table readable, no writes, no column denies. */
  policy?: z.input<typeof PolicySchema>;
  /** Reject (`rate_limited`) query/execute calls beyond this many in flight. Omitted = no cap. */
  maxConcurrentQueries?: number;
}

const Params = z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional();
const EXECUTE_STATEMENTS = new Set(['insert', 'update', 'delete']);

export class SqlConnector implements Connector {
  readonly id: string;
  readonly kind = 'sql' as const;
  private readonly dialect: SqlDialect;
  private readonly policy: Policy;
  private logger?: ConnectorInitCtx['logger'];
  private cachedTables?: TableSchema[];
  private readonly maxConcurrent: number;
  private inFlight = 0;
  // ponytail: in-memory, single process, lost on restart. Move to the DB (a keys table in the
  // same transaction) if replays must survive restarts or span replicas.
  private readonly idempotency = new Map<
    string,
    { fingerprint: string; expires: number; result: Promise<unknown> }
  >();

  /** Every denied column name, table-agnostic, lowercased. Used for the output-side filter. */
  private readonly deniedColumnNames: ReadonlySet<string>;

  constructor(opts: SqlConnectorOptions) {
    this.id = opts.id;
    this.dialect = opts.dialect;
    this.policy = PolicySchema.parse(opts.policy ?? {});
    this.maxConcurrent = opts.maxConcurrentQueries ?? Infinity;
    this.deniedColumnNames = new Set(
      this.policy.denyColumns.map((c) => c.slice(c.lastIndexOf('.') + 1).toLowerCase()),
    );
  }

  /**
   * Privileges the database user holds that would let a query bypass the policy (superuser,
   * server file access, ...). Empty when the dialect can't tell or nothing is wrong.
   */
  async auditPrivileges(): Promise<string[]> {
    return this.dialect.auditPrivileges ? this.dialect.auditPrivileges() : [];
  }

  /** True when the policy grants `write` on at least one table. */
  get writable(): boolean {
    return Object.values(this.policy.tables).includes('write');
  }

  async init(ctx: ConnectorInitCtx): Promise<void> {
    this.logger = ctx.logger;
    await this.dialect.connect({ writable: this.writable });
    this.logger.info('connector.sql.connected', { id: this.id, dialect: this.dialect.kind });
  }

  async close(): Promise<void> {
    await this.dialect.close();
  }

  async health(): Promise<{ ok: boolean; latencyMs: number; details?: string }> {
    return this.dialect.ping();
  }

  async introspect(): Promise<SchemaSnapshot> {
    const tables = await this.dialect.listTables();
    this.cachedTables = tables;
    return { kind: 'sql', tables };
  }

  listPrimitiveTools(): ToolDefinition[] {
    const id = this.id;
    return [
      {
        name: `${id}.list_tables`,
        description: `List all tables and their columns in the ${id} database.`,
        inputSchema: z.object({}).strict(),
        scopes: ['schema:read'],
        readOnly: true,
        handler: async () => {
          const tables = await this.cachedOrFetchTables();
          return {
            content: [{ type: 'json', data: tables }],
            metadata: { rows: tables.length },
          };
        },
      },
      {
        name: `${id}.describe_table`,
        description: `Describe one table in the ${id} database, including columns, types, and primary key.`,
        inputSchema: z
          .object({
            name: z
              .string()
              .min(1)
              .describe('Table name. Use schema-qualified form if needed (e.g. "public.users").'),
          })
          .strict(),
        scopes: ['schema:read'],
        readOnly: true,
        handler: async ({ name }) => {
          const tables = await this.cachedOrFetchTables();
          const found = tables.find(
            (t) =>
              qualifiedName(t).toLowerCase() === name.toLowerCase() ||
              t.name.toLowerCase() === name.toLowerCase(),
          );
          if (!found) {
            throw new McpolyglotError('not_found', `Table "${name}" not found in ${id}`);
          }
          return { content: [{ type: 'json', data: found }] };
        },
      },
      {
        name: `${id}.query`,
        description: `Run a read-only SQL query against the ${id} database. Use parameterized form ($1, $2, ...). Writes are rejected.`,
        inputSchema: z
          .object({
            sql: z
              .string()
              .min(1)
              .describe('SQL query string. Read-only — INSERT/UPDATE/DELETE/DDL will be rejected.'),
            params: Params,
            limit: z.number().int().positive().max(1000).optional(),
            dryRun: z
              .boolean()
              .optional()
              .describe('Return the policy decision without executing the query.'),
          })
          .strict(),
        scopes: ['tables:read', 'query:raw'],
        readOnly: true,
        handler: async ({ sql, params, limit, dryRun }, ctx) => {
          const decision = classify(sql, this.policy, this.dialect.kind);
          if (dryRun) {
            return { content: [{ type: 'json', data: { dryRun: true, decision } }] };
          }
          if (!decision.allow) {
            throw new McpolyglotError('forbidden.policy', decision.reason, {
              tables: decision.tables,
            });
          }
          const rowCap = Math.min(
            limit ?? ctx.limits.rowCap,
            ctx.limits.rowCap,
            this.policy.maxRows ?? Infinity,
          );
          const result = await this.limited(() =>
            this.dialect.runReadOnly(sql, params ?? [], {
              rowCap,
              timeoutMs: this.timeoutMs(ctx),
              signal: ctx.signal,
            }),
          );
          // Second layer behind the classifier: a denied column that still arrives inside a
          // record/JSON value (row_to_json, json_agg, a whole-row alias) is dropped here.
          const filtered = this.deniedColumnNames.size
            ? {
                ...result,
                columns: result.columns.filter((c) => !this.deniedColumnNames.has(c.toLowerCase())),
                rows: stripDeniedKeys(result.rows, this.deniedColumnNames) as Record<
                  string,
                  unknown
                >[],
              }
            : result;
          return {
            content: [{ type: 'json', data: filtered }],
            metadata: { rows: filtered.rowCount, truncated: filtered.truncated },
          };
        },
      },
      ...(this.writable ? [this.executeTool()] : []),
    ];
  }

  private executeTool(): ToolDefinition {
    const id = this.id;
    return {
      name: `${id}.execute`,
      description: `Run one INSERT/UPDATE/DELETE against the ${id} database, in a transaction. Rolled back if it changes more than ${this.policy.maxWritesPerCall} row(s).`,
      inputSchema: z
        .object({
          sql: z.string().min(1).describe('One INSERT, UPDATE, or DELETE. Parameterized.'),
          params: Params,
          dryRun: z.boolean().optional().describe('Return the policy decision without executing.'),
          idempotencyKey: z
            .string()
            .min(1)
            .max(200)
            .optional()
            .describe(
              `Retrying with the same key within ${this.policy.idempotencyWindowMinutes} min returns the first result instead of writing again.`,
            ),
        })
        .strict(),
      scopes: ['tables:write'],
      readOnly: false,
      handler: async ({ sql, params, dryRun, idempotencyKey }, ctx) => {
        let decision = classify(sql, this.policy, this.dialect.kind);
        if (decision.allow && !EXECUTE_STATEMENTS.has(decision.statement ?? '')) {
          decision = {
            ...decision,
            allow: false,
            reason: `execute only runs INSERT/UPDATE/DELETE; got ${decision.statement?.toUpperCase()}. Use query for reads.`,
          };
        }
        if (dryRun) return { content: [{ type: 'json', data: { dryRun: true, decision } }] };
        if (!decision.allow) {
          throw new McpolyglotError('forbidden.policy', decision.reason, {
            tables: decision.tables,
          });
        }

        const run = () =>
          this.limited(() =>
            this.dialect.runWrite(sql, params ?? [], {
              maxRowsAffected: this.policy.maxWritesPerCall,
              timeoutMs: this.timeoutMs(ctx),
              signal: ctx.signal,
            }),
          );
        const { rowsAffected } = idempotencyKey
          ? ((await this.idempotent(idempotencyKey, JSON.stringify([sql, params ?? []]), run)) as {
              rowsAffected: number;
            })
          : await run();
        return {
          content: [{ type: 'json', data: { rowsAffected } }],
          metadata: { rows: rowsAffected },
        };
      },
    };
  }

  /** Replay a same-key call within the window; refuse a same-key call with different args. */
  private idempotent(key: string, fingerprint: string, run: () => Promise<unknown>) {
    const now = Date.now();
    for (const [k, v] of this.idempotency) if (v.expires <= now) this.idempotency.delete(k);
    const prev = this.idempotency.get(key);
    if (prev) {
      if (prev.fingerprint !== fingerprint) {
        throw new McpolyglotError(
          'invalid_argument',
          `idempotencyKey "${key}" was already used with different sql/params.`,
        );
      }
      return prev.result;
    }
    // Store the promise, not the value, so a concurrent retry waits for the first call.
    const result = run();
    this.idempotency.set(key, {
      fingerprint,
      expires: now + this.policy.idempotencyWindowMinutes * 60_000,
      result,
    });
    result.catch(() => this.idempotency.delete(key)); // failures aren't cached; retry may run
    return result;
  }

  private async limited<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.maxConcurrent) {
      throw new RateLimitError(
        `${this.id}: ${this.maxConcurrent} queries already in flight (maxConcurrentQueries).`,
      );
    }
    this.inFlight++;
    try {
      return await fn();
    } finally {
      this.inFlight--;
    }
  }

  private timeoutMs(ctx: { limits: { timeoutMs: number } }): number {
    return Math.min(ctx.limits.timeoutMs, this.policy.statementTimeoutMs ?? Infinity);
  }

  generatePerEntityTools(_cfg: PerEntityConfig): ToolDefinition[] {
    // Not implemented: opt-in per-table tools would be generated from the cached schema.
    return [];
  }

  private async cachedOrFetchTables(): Promise<TableSchema[]> {
    if (!this.cachedTables) {
      this.cachedTables = await this.dialect.listTables();
    }
    return this.cachedTables.flatMap((t) => {
      if (tableAccess(this.policy, t.schema ?? 'null', t.name) === 'none') return [];
      return [
        { ...t, columns: t.columns.filter((c) => !isColumnDenied(this.policy, t.name, c.name)) },
      ];
    });
  }
}

/**
 * Recursively remove keys named like a denied column from plain objects and arrays.
 * Dates, buffers, and other class instances pass through untouched.
 */
export function stripDeniedKeys(value: unknown, denied: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => stripDeniedKeys(v, denied));
  if (value === null || typeof value !== 'object') return value;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (denied.has(k.toLowerCase())) continue;
    out[k] = stripDeniedKeys(v, denied);
  }
  return out;
}

function qualifiedName(t: TableSchema): string {
  return t.schema ? `${t.schema}.${t.name}` : t.name;
}
