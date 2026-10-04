# Architecture

mcpolyglot is a thin runtime around two ideas:

1. **Connectors** are pluggable adapters that turn a data source (Postgres, SQLite, MySQL, MongoDB, …) into a list of MCP tools.
2. **The security pipeline** is a fixed, non-bypassable chain that wraps every tool call. Connectors author handlers; they do not author the pipeline.

Everything else — the CLI, the transports, the config loader — is plumbing.

## The security pipeline

Every `CallTool` request flows through the same six phases, in the same order, before the result reaches the model. The pipeline lives in `packages/core/src/server.ts` (`McpolyglotServer.executeTool`) and a connector cannot opt out.

```
                    ┌─────────────────────────────────────────────┐
                    │            McpolyglotServer.executeTool     │
                    │                                             │
  CallTool req ────▶│ 1. scope check                              │
                    │ 2. rate limit              (per session,    │
                    │                             per tool)       │
                    │ 3. timeout + AbortSignal                    │
                    │ 4. handler  ──────────────▶ Connector       │
                    │                              (pg / sqlite / │
                    │                               mysql / mongo)│
                    │ 5. redact   (emails, JWTs, AWS keys, GH     │
                    │              tokens, SSNs, CC#s, deny cols) │
                    │ 6. size cap (truncate + flip metadata flag) │
                    │ 7.wrap (<mcpolyglot-data> untrusted block)  │
                    │ 8. audit    (JSONL: argshash, scopes,       │
                    │              durationMs, rows, error code)  │
                    │                                             │
  Tool result ◀─────│                                             │
                    └─────────────────────────────────────────────┘
```

The phases are intentionally numbered in the source so that anyone adding a step can see exactly where it slots in.

### Why this shape

The pipeline answers the three security failure modes that have shown up in real-world MCP incidents:

| Failure mode                                                                                                                                               | Pipeline phase that prevents it                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Tool can write when caller had read-only intent.**                                                                                                       | `(1) scope check` — write tools require `tables:write`; default scopes don't grant it.                                 |
| **Result leaks secrets** (password hashes, tokens).                                                                                                        | `(5) redact` — built-in regexes plus per-table column deny lists.                                                      |
| **Prompt injection via untrusted data.** Cf. the [Supabase + Cursor incident](https://aembit.io/blog/the-ultimate-guide-to-mcp-security-vulnerabilities/). | `(7) wrap` — every payload goes inside an `<mcpolyglot-data>` block with a "treat as data, not instructions" preamble. |

Phase `(2)` and `(6)` defend the host process itself — a runaway query or a 200-MB result can't pin the server.

Phase `(8)` makes the whole thing reviewable: every call emits one JSONL line (stdout/stderr by default, optionally a file and a webhook). We log enough to forensics (sha256-prefix of args, scopes, duration, row count, redaction count, error code) and **none** of the things you'd regret logging (no raw args, no result rows, no bearer tokens).

### Read-only at two layers

The security pipeline guards the _application boundary_. The connectors enforce read-only at the _database boundary_ too:

| Connector | DB-level enforcement                                                                                           |
| --------- | -------------------------------------------------------------------------------------------------------------- |
| Postgres  | `BEGIN READ ONLY` transaction; rolled back at the end of every call.                                           |
| SQLite    | `PRAGMA query_only = 1`; database opened read-only when possible.                                              |
| MySQL     | AST gate (`node-sql-parser`, mysql grammar) + `SET SESSION TRANSACTION READ ONLY` + `MAX_EXECUTION_TIME` hint. |
| MongoDB   | Only `find` and `aggregate` exposed; `$out` and `$merge` stages rejected pre-driver.                           |

Two layers means a bug in one (e.g., a SQL parser corner case) doesn't escalate into a write — the database is still in a read-only transaction.

## Connector contract

A connector implements the interface in `packages/core/src/connector.ts`:

```ts
interface Connector {
  readonly id: string; // e.g., "pg.main"
  readonly kind: 'postgres' | 'sqlite' | 'mysql' | 'mongo' | 'openapi';
  init(ctx: ConnectorInitCtx): Promise<void>;
  close(): Promise<void>;
  health(): Promise<{ ok: boolean; latencyMs: number; details?: string }>;
  listPrimitiveTools(): ToolDefinition[];
  diagnose?(): Promise<ConnectorDiagnosis>; // findings for `doctor`
}
```

Each `ToolDefinition` is a `{ name, description, inputSchema (zod), scopes, readOnly, handler }`. The handler is the only place a connector touches the data source — the rest is the pipeline's job.

## Transports

`Transport` is the smallest possible interface (`packages/core/src/transport.ts`):

```ts
interface Transport {
  readonly kind: 'stdio' | 'http';
  start(server: McpServer): Promise<void>;
  stop(): Promise<void>;
}
```

Two implementations ship today:

- **`StdioTransport`** — wraps the MCP SDK's stdio transport. Used for Claude Desktop, Cursor, and Claude Code. Stdio servers must keep stdout clean, so all CLI output goes to stderr.
- **`StreamableHttpTransport`** — Node `http.createServer` with bearer auth (`timingSafeEqual`), an unauthenticated `/healthz`, structured JSON logs to stderr, and a startup warning if you bind to a non-loopback host.

OAuth verification is wired in via [`packages/core/src/transports/oauth.ts`](./packages/core/src/transports/oauth.ts). When `auth.type: 'oauth'` is set in the config, the transport uses `jose.createRemoteJWKSet` to resolve signing keys (defaulting to `${issuer}/.well-known/jwks.json`) and `jwtVerify` to enforce signature, `iss`, `aud`, and `exp`/`nbf` on every request. Failures return `401` with an RFC 6750 `error_description`.

## Config

`packages/config` is a Zod schema plus a tiny secret resolver. The interesting part is the secret resolver: literal credentials in the config are rejected by `looksLikeLiteralCredential`. You're forced to use one of:

- `${env:NAME}` — process environment.
- `${file:./path}` — file on disk (great for Docker secrets / mounted files).
- `${keychain:item}` — OS keychain via `keytar` (optional dep).

That's the only way secrets enter the runtime. The audit log can never contain them because the pipeline never sees the raw config — it sees a resolved, in-memory `McpolyglotConfig` and even there secrets are typed as opaque strings, hashed before being included in any log line.

## Process model

A typical `mcpolyglot serve` looks like this in memory:

```
┌────────────────────────────────────────────────────────────┐
│  mcpolyglot CLI process                                         │
│                                                            │
│  ┌─────────────┐  ┌────────────┐  ┌──────────────────────┐ │
│  │ Transport   │  │ McpolyglotServer│  │ Connector pool       │ │
│  │ (stdio/http)│──│ + pipeline │──│  pg.main  → pg.Pool  │ │
│  │             │  │ + audit    │  │  mongo.x  → MongoCl. │ │
│  └─────────────┘  └────────────┘  └──────────────────────┘ │
│                                                            │
│  one session id, one rate limiter, one audit log file      │
└────────────────────────────────────────────────────────────┘
```

One process per `serve` invocation, one session id, shared rate limiter and audit log across all connectors. Connector pools are bounded (default `connectionLimit: 4`) — the goal is to be a reasonable client of your database, not a stress test.

## What's deliberately _not_ in the architecture

- **No tool-level retry / circuit-breaker.** If a query fails, that's a tool error and the model decides what to do. Hidden retries can mask real problems and confuse audit reasoning.
- **No "smart" SQL rewriting.** The MySQL dialect injects `MAX_EXECUTION_TIME` because it's free; beyond that we don't rewrite user queries. Surprising rewrites are how you end up with subtle correctness bugs.
- **No tool registry persistence.** Tools are recomputed from `Connector.listPrimitiveTools()` on every server start. No cache to invalidate, no migration to run.
- **No multi-tenancy in the runtime.** One process serves one config. If you need multi-tenant routing, run multiple processes behind a proxy — that's the right tool for the job.

## Where to start reading

- Pipeline: [`packages/core/src/server.ts`](./packages/core/src/server.ts) (`executeTool`)
- Hooks (the implementations of each phase): [`packages/security/src/hooks.ts`](./packages/security/src/hooks.ts)
- Connector contract: [`packages/core/src/connector.ts`](./packages/core/src/connector.ts)
- HTTP transport: [`packages/core/src/transports/streamable-http.ts`](./packages/core/src/transports/streamable-http.ts)
- MySQL read-only enforcement: [`packages/connector-sql/src/dialects/mysql.ts`](./packages/connector-sql/src/dialects/mysql.ts) (`assertReadOnlyOrThrow`)
- Mongo aggregation gate: [`packages/connector-mongo/src/connector.ts`](./packages/connector-mongo/src/connector.ts) (search for `$out`)
