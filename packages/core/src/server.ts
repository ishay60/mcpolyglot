import { randomUUID, createHash } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { z } from 'zod';
import type { Connector } from './connector.js';
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
  /**
   * Phase 2 — token-bucket + concurrency gate. Throws `RateLimitError` on violation. May
   * return a release function; the server calls it when the call finishes.
   */
  checkRateLimit(toolName: string, sessionId: string): Promise<void | (() => void)>;
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
  /** Limits per connector, keyed by `connector.id`. A connector not listed uses `defaultLimits`. */
  limits?: Record<string, ToolExecLimits>;
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
  /**
   * The agent authenticated by its HTTP token when `agents` is configured. Otherwise
   * client-asserted: the `x-mcpolyglot-agent` header (HTTP), else MCP `clientInfo.name`.
   */
  agentId?: string;
  tool: string;
  /** `deny` = rejected by policy/scope/rate limit/timeout; `error` = anything else that failed. */
  decision: 'allow' | 'deny' | 'error';
  /** Why the call was denied or failed. */
  reason?: string;
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
  /** Scopes granted to the calling session. Defaults to `DEFAULT_SCOPES` (read-only). */
  scopes?: readonly Scope[];
  security: SecurityServices;
  /**
   * Per-agent grants. A request whose transport authenticated one of these ids (via
   * `authInfo.clientId`) sees only that agent's connectors and scopes. Requests without an
   * authenticated agent (stdio, plain bearer) use `connectors` + `scopes` as before.
   */
  agents?: AgentGrant[];
  logger?: {
    debug: (msg: string, fields?: Record<string, unknown>) => void;
    info: (msg: string, fields?: Record<string, unknown>) => void;
    warn: (msg: string, fields?: Record<string, unknown>) => void;
    error: (msg: string, fields?: Record<string, unknown>) => void;
  };
}

/** What one authenticated agent may use. */
export interface AgentGrant {
  id: string;
  scopes: readonly Scope[];
  /** Connectors this agent sees; may be per-agent instances (e.g. with their own policy). */
  connectors: Connector[];
}

interface Caller {
  agentId?: string;
  scopes: Set<Scope>;
  tools: Map<string, ToolDefinition>;
  rateKey: string;
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
  private readonly info: { name: string; version: string };
  private readonly tools = new Map<string, ToolDefinition>();
  /** Tool name → the limits of the connector it came from. */
  private readonly toolLimits = new Map<string, ToolExecLimits>();
  private readonly connectors: Connector[];
  private readonly scopes: Set<Scope>;
  private readonly agents: Map<string, AgentGrant & { tools: Map<string, ToolDefinition> }>;
  private readonly security: SecurityServices;
  private readonly sessionId = randomUUID();
  private readonly logger: NonNullable<McpolyglotServerOptions['logger']>;
  private transport?: Transport;

  constructor(opts: McpolyglotServerOptions) {
    this.connectors = opts.connectors;
    this.scopes = new Set(opts.scopes ?? DEFAULT_SCOPES);
    this.security = opts.security;
    this.logger = opts.logger ?? makeNoopLogger();
    this.agents = new Map((opts.agents ?? []).map((a) => [a.id, { ...a, tools: new Map() }]));

    this.info = { name: opts.name ?? 'mcpolyglot', version: opts.version ?? '0.0.1' };
  }

  /**
   * A fresh MCP protocol server bound to this instance's tools and pipeline. Stdio makes one;
   * the stateless HTTP transport makes one per request (the SDK forbids reusing either).
   */
  private createMcpServer(): Server {
    const server = new Server(this.info, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async (_req, extra) => ({
      tools: Array.from(this.caller(server, extra).tools.values()).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: z.toJSONSchema(t.inputSchema, { target: 'draft-7' }) as Record<
          string,
          unknown
        >,
      })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const caller = this.caller(server, extra);
      const def = caller.tools.get(req.params.name);
      if (!def) {
        throw new McpolyglotError('tool.not_found', `Unknown tool: ${req.params.name}`);
      }
      const internal = await this.executeTool(def, req.params.arguments ?? {}, caller);
      return toMcpResult(internal);
    });
    return server;
  }

  async start(transport: Transport): Promise<void> {
    for (const c of this.allConnectors()) {
      await c.init({ logger: this.logger });
      const limits = this.security.limits?.[c.id];
      if (limits) for (const tool of this.toolsOf(c)) this.toolLimits.set(tool.name, limits);
    }
    for (const c of this.connectors) {
      for (const tool of this.toolsOf(c)) registerTool(this.tools, tool);
    }
    for (const a of this.agents.values()) {
      for (const c of a.connectors) {
        for (const tool of this.toolsOf(c)) {
          // Agents only see tools their scopes fully cover.
          if (tool.scopes.every((s) => a.scopes.includes(s))) registerTool(a.tools, tool);
        }
      }
    }
    this.transport = transport;
    await transport.start(() => this.createMcpServer());
    this.logger.info('mcpolyglot.started', {
      sessionId: this.sessionId,
      transport: transport.kind,
      tools: this.tools.size,
    });
  }

  async stop(): Promise<void> {
    await this.transport?.stop();
    for (const c of this.allConnectors()) {
      await c.close();
    }
  }

  private allConnectors(): Set<Connector> {
    return new Set([...this.connectors, ...[...this.agents.values()].flatMap((a) => a.connectors)]);
  }

  private toolsOf(c: Connector): ToolDefinition[] {
    return c.listPrimitiveTools();
  }

  /**
   * Who is calling. Only `authInfo` set by our HTTP transport identifies an agent; headers
   * and clientInfo are client-asserted and only used as an audit label when it's absent.
   */
  private caller(
    server: Server,
    extra: {
      authInfo?: AuthInfo;
      requestInfo?: { headers: Record<string, string | string[] | undefined> };
    },
  ): Caller {
    const agent = extra.authInfo ? this.agents.get(extra.authInfo.clientId) : undefined;
    if (agent) {
      return {
        agentId: agent.id,
        scopes: new Set(agent.scopes),
        tools: agent.tools,
        rateKey: `agent:${agent.id}`,
      };
    }
    const header = extra.requestInfo?.headers['x-mcpolyglot-agent'];
    return {
      agentId: (Array.isArray(header) ? header[0] : header) ?? server.getClientVersion()?.name,
      scopes: this.scopes,
      tools: this.tools,
      rateKey: this.sessionId,
    };
  }

  /**
   * Fixed pipeline: scope check → rate limit → timeout → handler →
   * redaction → size cap → untrusted-wrap → audit log → response.
   * Connectors cannot bypass.
   */
  private async executeTool(
    def: ToolDefinition,
    rawArgs: unknown,
    caller: Caller,
  ): Promise<ToolResult> {
    const { agentId, scopes } = caller;
    const started = Date.now();
    const argsHash = hashArgs(rawArgs);
    let result: ToolResult | undefined;
    let errorEntry: AuditEntry['error'];
    let decision: AuditEntry['decision'] = 'allow';
    let release: void | (() => void) = undefined;

    const limits = this.toolLimits.get(def.name) ?? this.security.defaultLimits;

    try {
      // 1. scope check
      this.security.hooks.checkScopes(def.name, def.scopes, scopes);

      // 2. rate limit
      release = await this.security.hooks.checkRateLimit(def.name, caller.rateKey);

      // 3. timeout
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), limits.timeoutMs);

      const ctx: ToolExecCtx = {
        sessionId: this.sessionId,
        scopes,
        signal: ac.signal,
        limits,
        logger: this.logger,
      };

      // Race the handler against the timer: a handler that ignores `signal` (a sync driver,
      // a hung socket) must still not hold the call open past the limit.
      const timedOut = new Promise<never>((_, reject) =>
        ac.signal.addEventListener('abort', () =>
          reject(new TimeoutError(`Tool ${def.name} exceeded ${ctx.limits.timeoutMs}ms`)),
        ),
      );
      try {
        const parsed = def.inputSchema.parse(rawArgs);
        result = await Promise.race([def.handler(parsed, ctx), timedOut]);
      } finally {
        clearTimeout(timer);
      }

      // 4. redaction
      const redacted = this.security.hooks.redact(def.name, result);
      result = redacted.result;

      // 5. size cap
      result = this.security.hooks.enforceSize(def.name, result, limits.maxBytes);

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
      decision = err instanceof McpolyglotError && isPolicyRejection(err.code) ? 'deny' : 'error';
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
      release?.();
      await this.security.hooks.audit({
        ts: new Date().toISOString(),
        sessionId: this.sessionId,
        ...(agentId ? { agentId } : {}),
        tool: def.name,
        decision,
        ...(errorEntry ? { reason: errorEntry.message } : {}),
        argsHash,
        scopes: Array.from(scopes),
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

function registerTool(map: Map<string, ToolDefinition>, tool: ToolDefinition): void {
  if (map.has(tool.name)) {
    throw new McpolyglotError('tool.duplicate', `Duplicate tool name: ${tool.name}`);
  }
  map.set(tool.name, tool);
}
