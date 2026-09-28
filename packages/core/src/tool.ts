import type { z } from 'zod';

/**
 * Loose Zod schema type used as the default bound on `ToolDefinition` /
 * `ToolHandler`. We deliberately type the output as `any` so a connector
 * defining `inputSchema: z.object({ name: z.string() })` can write
 * `handler: ({ name }) => ...` without an explicit generic — the destructure
 * remains permissive while runtime parsing still enforces the schema.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
export type AnyZodSchema = z.ZodType<any>;
export type ZodInfer<S extends AnyZodSchema> = z.infer<S>;

/** Every scope mcpolyglot understands. New scopes must be added here so the Zod config schema accepts them. */
export const ALL_SCOPES = [
  'schema:read',
  'tables:read',
  'tables:write',
  'query:raw',
  'http:call',
] as const;

/** A capability a tool requires from the calling session. Checked by `ScopeGuard`. */
export type Scope = (typeof ALL_SCOPES)[number];

/** Scopes granted to a session by default. Excludes anything write-shaped. */
export const DEFAULT_SCOPES: readonly Scope[] = ['schema:read', 'tables:read'];

/** One block in a `ToolResult.content`. Either pre-rendered text or structured JSON. */
export interface ContentBlock {
  type: 'text' | 'json';
  text?: string;
  data?: unknown;
}

/** What a tool handler returns. Goes through redact → size-cap → wrap before reaching the model. */
export interface ToolResult {
  content: ContentBlock[];
  /** Set when the handler intentionally surfaces an error (e.g., scope failure rendered as a tool result). */
  isError?: boolean;
  metadata?: {
    rows?: number;
    /** `true` if the size cap or row cap had to truncate the result. */
    truncated?: boolean;
    /** Filled in by the pipeline; handlers don't need to set this. */
    durationMs?: number;
    /** Filled in by the pipeline; handlers don't need to set this. */
    redactionsApplied?: number;
  };
}

/** Per-call execution limits. Pulled from config; can be tightened per-source. */
export interface ToolExecLimits {
  /** Max rows a SQL/Mongo handler may return before truncation. */
  rowCap: number;
  /** Wall-clock budget for the handler. Enforced via `AbortSignal`. */
  timeoutMs: number;
  /** Hard cap on the serialized output size, in bytes. */
  maxBytes: number;
}

/** Runtime context handed to a tool handler on every call. */
export interface ToolExecCtx {
  /** Stable id for the calling session. Used by the rate limiter and audit log. */
  sessionId: string;
  /** Scopes granted to this session. The pipeline already checked the tool's `scopes` against these. */
  scopes: Set<Scope>;
  /** Aborted when `limits.timeoutMs` elapses. Pass to driver-level cancel APIs where supported. */
  signal: AbortSignal;
  limits: ToolExecLimits;
  logger: {
    debug: (msg: string, fields?: Record<string, unknown>) => void;
    info: (msg: string, fields?: Record<string, unknown>) => void;
    warn: (msg: string, fields?: Record<string, unknown>) => void;
    error: (msg: string, fields?: Record<string, unknown>) => void;
  };
}

/**
 * Handler signature for a tool. Args are pre-validated against `ToolDefinition.inputSchema`,
 * so the function receives a parsed, typed value — no defensive validation needed.
 */
export type ToolHandler<S extends AnyZodSchema = AnyZodSchema> = (
  args: ZodInfer<S>,
  ctx: ToolExecCtx,
) => Promise<ToolResult>;

/**
 * The contract every connector returns from `listPrimitiveTools()` /
 * `generatePerEntityTools()`. The `handler` is the only point where the connector
 * touches the data source — everything else (auth, redaction, audit) is the pipeline's job.
 *
 * @example
 * ```ts
 * import { z } from 'zod';
 *
 * const tool: ToolDefinition = {
 *   name: 'pg.main.describe_table',
 *   description: 'Describe one Postgres table.',
 *   inputSchema: z.object({ name: z.string() }).strict(),
 *   scopes: ['schema:read'],
 *   readOnly: true,
 *   handler: async ({ name }, ctx) => ({ content: [{ type: 'json', data: { name } }] }),
 * };
 * ```
 */
export interface ToolDefinition<S extends AnyZodSchema = AnyZodSchema> {
  /** Globally-unique tool name. By convention: `<connector.id>.<verb>`. */
  name: string;
  /** Human-readable description shown to the model in `tools/list`. */
  description: string;
  /** Zod schema for the args. Used both for validation and to render JSON Schema for MCP clients. */
  inputSchema: S;
  /** Scopes the calling session must have. Enforced before the handler runs. */
  scopes: readonly Scope[];
  /** `true` if the handler never mutates the source. Hosts may use this for UI hints. */
  readOnly: boolean;
  handler: ToolHandler<S>;
}
