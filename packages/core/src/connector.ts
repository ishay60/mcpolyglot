import type { ToolDefinition } from './tool.js';

/** Kind of data source a connector talks to. Drives schema shape. */
export type ConnectorKind = 'sql' | 'mongo' | 'openapi';

/** A single column in a SQL `TableSchema`. */
export interface ColumnSchema {
  name: string;
  /** Driver-reported type string. Not normalized — what the DB calls it. */
  type: string;
  nullable: boolean;
  primaryKey?: boolean;
  unique?: boolean;
  foreignKey?: { table: string; column: string };
}

/** A single SQL table as exposed to the model via `list_tables` / `describe_table`. */
export interface TableSchema {
  /** Schema/namespace (e.g., `"public"` on Postgres, the database on MySQL). Optional for SQLite. */
  schema?: string;
  name: string;
  columns: ColumnSchema[];
  /** Best-effort row-count estimate from the planner; not guaranteed. */
  rowCountEstimate?: number;
  comment?: string;
}

/**
 * A Mongo collection's *sampled-field* schema — Mongo doesn't have a fixed schema,
 * so this is inferred from a small `$sample` of documents at introspection time.
 */
export interface CollectionSchema {
  name: string;
  /** Field paths observed in the sample, with the set of types each one took. */
  sampledFields: Array<{ path: string; types: string[]; nullable: boolean }>;
  documentCountEstimate?: number;
}

/** A single OpenAPI operation as exposed by a future REST connector. */
export interface OperationSchema {
  operationId: string;
  method: string;
  path: string;
  summary?: string;
  parameters: Array<{
    name: string;
    in: 'query' | 'path' | 'header';
    required: boolean;
    type: string;
  }>;
  requestBody?: { contentType: string; schemaRef?: string };
}

/** What `mcpolyglot doctor` shows for a source beyond its health. */
export interface ConnectorDiagnosis {
  /** Labelled lists worth showing, e.g. `{ readable: ['users'], hidden: ['secrets'] }`. */
  facts: Record<string, string[]>;
  /** Anything here fails `doctor`. `check` names what was checked, e.g. `'policy'`. */
  problems: Array<{ check: string; message: string }>;
}

/** Runtime context handed to a connector's `init()`. */
export interface ConnectorInitCtx {
  logger: {
    debug: (msg: string, fields?: Record<string, unknown>) => void;
    info: (msg: string, fields?: Record<string, unknown>) => void;
    warn: (msg: string, fields?: Record<string, unknown>) => void;
    error: (msg: string, fields?: Record<string, unknown>) => void;
  };
}

/**
 * Adapter that turns a data source into a list of MCP tools.
 *
 * A connector authors *handlers* — it does **not** author the security pipeline.
 * Every tool a connector returns is wrapped by `McpolyglotServer.executeTool` with
 * scope check, rate limit, timeout, redaction, size cap, untrusted-wrap, and audit.
 *
 * @example
 * ```ts
 * import type { Connector } from '@mcpolyglot/core';
 *
 * class MyConnector implements Connector {
 *   readonly id = 'my.source';
 *   readonly kind = 'sql' as const;
 *   async init(ctx) {}            // open pool, verify connectivity
 *   async close() {}               // drain pool
 *   async health() { return { ok: true, latencyMs: 0 }; }
 *   listPrimitiveTools() { return []; }   // ToolDefinition[]
 * }
 * ```
 */
export interface Connector {
  /** Stable id, e.g., `"pg.main"`. Tool names are namespaced by this id. */
  readonly id: string;
  readonly kind: ConnectorKind;
  /** Open the pool / driver and verify connectivity. Called once on `server.start()`. */
  init(ctx: ConnectorInitCtx): Promise<void>;
  /** Drain the pool / driver. Called on `server.stop()`. Must be idempotent. */
  close(): Promise<void>;
  /** Tools always exposed for this source (e.g., `list_tables`, `query`). */
  listPrimitiveTools(): ToolDefinition[];
  /** Lightweight ping. Used by `mcpolyglot doctor` and HTTP `/healthz`. */
  health(): Promise<{ ok: boolean; latencyMs: number; details?: string }>;
  /**
   * Source-specific findings for `mcpolyglot doctor`: what the configured access exposes and
   * anything wrong with it. Called after `init()`. Omit when there is nothing to report.
   */
  diagnose?(): Promise<ConnectorDiagnosis>;
}
