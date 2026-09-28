import { randomUUID, createHash } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Connector, PerEntityConfig } from './connector.js';
import type { Transport } from './transport.js';
import {
  type Scope,
  type ToolDefinition,
  type ToolExecCtx,
  type ToolExecLimits,
  type ToolResult,
  DEFAULT_SCOPES,
} from './tool.js';
import { McpolyglotError, TimeoutError } from './errors.js';

/**
 * The non-bypassable pipeline that wraps every tool call. Implementations live in
 * `@mcpolyglot/security`; consumers usually get one via `defaultSecurityHooks()` and don't
 * implement this directly.
 *
 * Every method here corresponds to a numbered phase in `McpolyglotServer.executeTool`.
 */
export interface SecurityHooks {
  /** Phase 1 — reject if granted scopes don't cover the tool's required scopes. */
  checkScopes(toolName: string, required: readonly Scope[], granted: ReadonlySet<Scope>): void;
  /** Phase 2 — token-bucket + concurrency gate. Throws `RateLimitError` on violation. */
  checkRateLimit(toolName: string, sessionId: string): Promise<void>;
  /** Phase 5 — strip secrets, drop denied columns. Returns the new result and the redaction count. */
  redact(toolName: string, result: ToolResult): { result: ToolResult; redactionsApplied: number };
  /** Phase 6 — hard cap on serialized output bytes. Truncates and flips `metadata.truncated`. */
  enforceSize(toolName: string, result: ToolResult, maxBytes: number): ToolResult;
  /** Phase 7 — wrap the result so the model treats it as data, not instructions. */
  wrapUntrusted(result: ToolResult): ToolResult;
  /** Phase 8 — append one JSONL line. Never receives raw args or result rows. */
  audit(entry: AuditEntry): Promise<void>;
}

/** Bundle of security primitives `McpolyglotServer` needs. Built by `defaultSecurityHooks()`. */
export interface SecurityServices {
  hooks: SecurityHooks;
  defaultLimits: ToolExecLimits;
  defaultScopes: readonly Scope[];
}

/**
 * One entry in the JSONL audit log. Logged for every call, including failed ones.
 * Args and result rows are deliberately absent — only metadata and a hash of the args.
 */
export interface AuditEntry {
  /** ISO-8601 UTC timestamp. */
  ts: string;
  sessionId: string;
  tool: string;
  /** First 16 chars of `sha256(JSON.stringify(args))`. Enough for forensics, not for reconstruction. */
  argsHash: string;
  scopes: Scope[];
  durationMs: number;
  rows?: number;
  truncated?: boolean;
  redactionsApplied?: number;
  error?: { code: string; message: string };
}

/** Constructor options for `McpolyglotServer`. */
export interface McpolyglotServerOptions {
  name?: string;
  version?: string;
  connectors: Connector[];
  /** Per-source per-entity configuration. Keyed by `connector.id`. */
  perEntity?: Record<string, PerEntityConfig>;
  /** Scopes granted to the calling session. Defaults to `DEFAULT_SCOPES` (read-only). */
  scopes?: readonly Scope[];
  security: SecurityServices;
  logger?: {
    debug: (msg: string, fields?: Record<string, unknown>) => void;
    info: (msg: string, fields?: Record<string, unknown>) => void;
    warn: (msg: string, fields?: Record<string, unknown>) => void;
    error: (msg: string, fields?: Record<string, unknown>) => void;
  };
}

/**
 * MCP server that wires connectors + security hooks + a transport.
 *
 * Every `CallTool` request goes through `executeTool`, which runs the same eight
 * numbered phases (scope → rate-limit → timeout → handler → redact → size cap →
 * wrap → audit) in the same order — connectors cannot opt out.
 *
 * @example
 * ```ts
 * import { McpolyglotServer } from '@mcpolyglot/core';
 * import { StdioTransport } from '@mcpolyglot/core/transports/stdio';
 * import { defaultSecurityHooks } from '@mcpolyglot/security';
 *
 * const server = new McpolyglotServer({
 *   connectors: [myConnector],
 *   security: {
 *     hooks: defaultSecurityHooks(),
 *     defaultLimits: { rowCap: 200, timeoutMs: 10_000, maxBytes: 256 * 1024 },
 *     defaultScopes: ['schema:read', 'tables:read'],
 *   },
 * });
 * await server.start(new StdioTransport());
 * ```
 */
export class McpolyglotServer {
  private readonly server: Server;
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly connectors: Connector[];
  private readonly perEntity: Record<string, PerEntityConfig>;
  private readonly scopes: Set<Scope>;
  private readonly security: SecurityServices;
  private readonly sessionId = randomUUID();
  private readonly logger: NonNullable<McpolyglotServerOptions['logger']>;
  private transport?: Transport;

  constructor(opts: McpolyglotServerOptions) {
    this.connectors = opts.connectors;
    this.perEntity = opts.perEntity ?? {};
    this.scopes = new Set(opts.scopes ?? DEFAULT_SCOPES);
    this.security = opts.security;
    this.logger = opts.logger ?? makeNoopLogger();

    this.server = new Server(
      { name: opts.name ?? 'mcpolyglot', version: opts.version ?? '0.0.1' },
      { capabilities: { tools: {} } },
    );

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: Array.from(this.tools.values()).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: z.toJSONSchema(t.inputSchema, { target: 'draft-7' }) as Record<
          string,
          unknown
        >,
      })),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const def = this.tools.get(req.params.name);
      if (!def) {
        throw new McpolyglotError('tool.not_found', `Unknown tool: ${req.params.name}`);
      }
      const internal = await this.executeTool(def, req.params.arguments ?? {});
      return toMcpResult(internal);
    });
  }

  async start(transport: Transport): Promise<void> {
    for (const c of this.connectors) {
      await c.init({ logger: this.logger });
      for (const tool of c.listPrimitiveTools()) {
        this.registerTool(tool);
      }
      const cfg = this.perEntity[c.id];
      if (cfg?.enabled) {
        for (const tool of c.generatePerEntityTools(cfg)) {
          this.registerTool(tool);
        }
      }
    }
    this.transport = transport;
    await transport.start(this.server);
    this.logger.info('mcpolyglot.started', {
      sessionId: this.sessionId,
      transport: transport.kind,
      tools: this.tools.size,
    });
  }

  async stop(): Promise<void> {
    await this.transport?.stop();
    for (const c of this.connectors) {
      await c.close();
    }
    await this.server.close();
  }

  private registerTool(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new McpolyglotError('tool.duplicate', `Duplicate tool name: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  /**
   * Fixed pipeline: scope check → rate limit → timeout → handler →
   * redaction → size cap → untrusted-wrap → audit log → response.
   * Connectors cannot bypass.
   */
  private async executeTool(def: ToolDefinition, rawArgs: unknown): Promise<ToolResult> {
    const started = Date.now();
    const argsHash = hashArgs(rawArgs);
    let result: ToolResult | undefined;
    let errorEntry: AuditEntry['error'];

    try {
      // 1. scope check
      this.security.hooks.checkScopes(def.name, def.scopes, this.scopes);

      // 2. rate limit
      await this.security.hooks.checkRateLimit(def.name, this.sessionId);

      // 3. timeout
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.security.defaultLimits.timeoutMs);

      const ctx: ToolExecCtx = {
        sessionId: this.sessionId,
        scopes: this.scopes,
        signal: ac.signal,
        limits: this.security.defaultLimits,
        logger: this.logger,
      };

      try {
        const parsed = def.inputSchema.parse(rawArgs);
        result = await def.handler(parsed, ctx);
      } finally {
        clearTimeout(timer);
        if (ac.signal.aborted && !result) {
          throw new TimeoutError(`Tool ${def.name} exceeded ${ctx.limits.timeoutMs}ms`);
        }
      }

      // 4. redaction
      const redacted = this.security.hooks.redact(def.name, result);
      result = redacted.result;

      // 5. size cap
      result = this.security.hooks.enforceSize(
        def.name,
        result,
        this.security.defaultLimits.maxBytes,
      );

      // 6. untrusted-data wrapper
      result = this.security.hooks.wrapUntrusted(result);

      result.metadata = {
        ...result.metadata,
        durationMs: Date.now() - started,
        redactionsApplied: redacted.redactionsApplied,
      };

      return result;
    } catch (err) {
      const e = err as Error & { code?: string };
      errorEntry = { code: e.code ?? 'internal_error', message: e.message };
      // Policy rejections (scope, read-only, rate limit, timeout) are tool errors the model
      // can read and correct, not protocol failures.
      if (err instanceof McpolyglotError && isPolicyRejection(err.code)) {
        return {
          content: [{ type: 'text', text: `${err.code}: ${e.message}` }],
          isError: true,
          metadata: { durationMs: Date.now() - started },
        };
      }
      throw err;
    } finally {
      await this.security.hooks.audit({
        ts: new Date().toISOString(),
        sessionId: this.sessionId,
        tool: def.name,
        argsHash,
        scopes: Array.from(this.scopes),
        durationMs: Date.now() - started,
        rows: result?.metadata?.rows,
        truncated: result?.metadata?.truncated,
        redactionsApplied: result?.metadata?.redactionsApplied,
        error: errorEntry,
      });
    }
  }
}

function isPolicyRejection(code: string): boolean {
  return code.startsWith('forbidden.') || code === 'rate_limited' || code === 'timeout';
}

function hashArgs(args: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(args ?? {}))
    .digest('hex')
    .slice(0, 16);
}

/** Translate mcpolyglot's internal ToolResult into the MCP CallToolResult shape. */
function toMcpResult(r: ToolResult): {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
} {
  return {
    content: r.content.map((b) => {
      if (b.type === 'text') return { type: 'text', text: b.text ?? '' };
      return { type: 'text', text: JSON.stringify(b.data ?? null, null, 2) };
    }),
    ...(r.isError ? { isError: true } : {}),
  };
}

function makeNoopLogger(): NonNullable<McpolyglotServerOptions['logger']> {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}
