import { z } from 'zod';
import type {
  Connector,
  ConnectorInitCtx,
  PerEntityConfig,
  SchemaSnapshot,
  TableSchema,
  ToolDefinition,
} from '@mcpolyglot/core';
import { McpolyglotError } from '@mcpolyglot/core';
import type { SqlDialect } from './dialect.js';
import { classify, isColumnDenied, PolicySchema, tableAccess, type Policy } from './policy.js';

export type SqlDialectKind = SqlDialect['kind'];

export interface SqlConnectorOptions {
  id: string;
  dialect: SqlDialect;
  /** Access policy. Omitted = every table readable, no writes, no column denies. */
  policy?: Policy;
}

export class SqlConnector implements Connector {
  readonly id: string;
  readonly kind = 'sql' as const;
  private readonly dialect: SqlDialect;
  private readonly policy: Policy;
  private logger?: ConnectorInitCtx['logger'];
  private cachedTables?: TableSchema[];

  constructor(opts: SqlConnectorOptions) {
    this.id = opts.id;
    this.dialect = opts.dialect;
    this.policy = PolicySchema.parse(opts.policy ?? {});
  }

  async init(ctx: ConnectorInitCtx): Promise<void> {
    this.logger = ctx.logger;
    await this.dialect.connect();
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
            params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
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
          const result = await this.dialect.runReadOnly(sql, params ?? [], {
            rowCap,
            timeoutMs: Math.min(ctx.limits.timeoutMs, this.policy.statementTimeoutMs ?? Infinity),
            signal: ctx.signal,
          });
          return {
            content: [{ type: 'json', data: result }],
            metadata: { rows: result.rowCount, truncated: result.truncated },
          };
        },
      },
    ];
  }

  generatePerEntityTools(_cfg: PerEntityConfig): ToolDefinition[] {
    // Wave 3 — opt-in per-table list/get/count tools generated from cached schema.
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

function qualifiedName(t: TableSchema): string {
  return t.schema ? `${t.schema}.${t.name}` : t.name;
}
