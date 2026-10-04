# @mcpolyglot/core

## 0.5.0

### Minor Changes

- 61e5457: **Fix:** each source's `limits` (row cap, timeout, byte cap) now apply to that source's tools. Previously the first source's limits were used for every tool and the others were ignored. `McpolyglotServer` takes `security.limits`, keyed by connector id.

  `Connector.introspect()` and `SchemaSnapshot` are replaced by an optional `Connector.diagnose()`, which returns what `doctor` shows for a source: labelled facts and problems. The SQL connector reports its policy against the live schema and risky database privileges there; `SqlConnector.auditPrivileges()` is gone and `checkPolicy` is now exported from `@mcpolyglot/connector-sql`. `doctor` output is unchanged.

## 0.4.0

### Minor Changes

- ea53e8f: Removed surface that did nothing:

  - **Per-entity tools.** No connector ever generated any. Gone: `Connector.generatePerEntityTools`, `PerEntityConfig`, the server's `perEntity` option and the `perEntityTools` source field. A `perEntityTools` key left in a JSON/YAML config is ignored; in a typed `.ts` config, delete the line.
  - **`security.wrapMode: 'minimal'`.** Use `'strict'` (default) or `'off'`.
  - **`@mcpolyglot/security`**: `composeHooks` is removed (it had no callers), and the `ScopeGuard` class is now a `checkScopes(toolName, required, granted)` function.
  - **`@mcpolyglot/testkit`** is no longer part of the repo; nothing used it.

## 0.3.0

### Minor Changes

- 24d8fa2: Per-agent HTTP auth: `agents: [{ id, tokens: [{ hash, revoked? }], scopes?, sources: { [id]: { policy? } } }]`. Tokens are stored as sha256 hashes and matched in constant time; the authenticated agent sees only its sources' tools that its scopes cover, gets its own policy per source, its own rate-limit bucket, and is the audit `agentId`. New `mcpolyglot token create|hash`; `doctor` lists each agent's tools. Without `agents` nothing changes.

  **Fix:** the HTTP transport now serves more than one request per process (SDK 1.30 forbids reusing a stateless transport; every request after the first returned 500). **Breaking for custom transports:** `Transport.start` now receives a `() => Server` factory instead of a `Server`. Under HTTP, `clientInfo.name` no longer labels audit entries (each request has its own protocol server); use the header or `agents`.

- 54d6b1b: Policy layer for SQL sources (per-table access, column denies, row/timeout caps, dry-run; DDL and unscoped UPDATE/DELETE always blocked). Audit entries gain `agentId`, `decision`, and `reason`; audit sinks are now console (default), file, and webhook. **Behavior change:** the audit log no longer goes to `~/.mcpolyglot/audit.log` unless `audit.path` is set.

  **Fixes:** the per-call timeout now cuts off handlers that ignore the abort signal (previously a hung MySQL/SQLite call never returned), and the concurrency cap now releases its slot when a call finishes (previously slots were held for 30s, so quick sequential calls hit "too many concurrent calls").

### Patch Changes

- 24d8fa2: `mcpolyglot init <url>` introspects a database and writes a config with a read-only policy: every table `read`, `defaultAccess: 'none'`, and suggested `denyColumns` from column names. `mcpolyglot doctor` now validates each SQL policy against the live schema (unknown tables and columns are errors) and lists readable, writable, and hidden tables and columns. New `@mcpolyglot/client` package: typed `listTables` / `query` over HTTP with policy denials as `McpolyglotDeniedError`. A root `Dockerfile` and `examples/docker-compose` ship too.

  **Fixes:** the Streamable HTTP transport answered only the first request; every later one returned 500. It now builds a fresh MCP server and transport per request. `doctor` no longer fails to connect when a source URL is a `${env:...}` reference: the credential check left a global regex's `lastIndex` set, so the URL was never resolved. `serve --http` no longer prints a bearer token that came from config.

## 0.2.0

### Minor Changes

- b98aaf6: Refresh CLI UI in a Copilot-CLI flavor and bump zod to v4.

  - New UI primitives in `@mcpolyglot/cli`: a boxed `headerBar` with a sub-command pill, pill-chip status indicators (`[ OK ]`, `[ ERR ]`, `[ READY ]`), section dividers, a `panel` for "next steps" callouts, a `footerBar` for hints, and a `step(n/total)` indicator for the `init` wizard.
  - `doctor`, `serve`, `tools`, and `init` adopt the new layout. The light `banner` is retained for compatibility.
  - `@mcpolyglot/core` now uses zod v4's built-in `z.toJSONSchema()` instead of the `zod-to-json-schema` package, dropping one dep.
  - `@mcpolyglot/config`, `@mcpolyglot/connector-sql`, and `@mcpolyglot/connector-mongo` upgraded to zod 4. `ZodTypeAny` was replaced with a permissive `AnyZodSchema` alias in core so existing connector handlers keep working without explicit generic annotations.
  - `@mcpolyglot/cli` upgraded `@clack/prompts` to v1 (validate signatures now allow `undefined`).

- 6f8b1d2: Wire OAuth (JWT + JWKS) verification into the Streamable HTTP transport.

  When `auth.type: 'oauth'` is set in the config, the transport now verifies bearer JWTs against the configured issuer/audience and a remote JWKS (cached + rotated by `jose`). The default JWKS path is `${issuer}/.well-known/jwks.json`, matching the convention used by Auth0, Okta, Keycloak, Cognito, and most OIDC providers.

  - New module: `@mcpolyglot/core` exposes `createOAuthVerifier({ issuer, audience, jwksUri? })` from `@mcpolyglot/core/transports/streamable-http`.
  - `StreamableHttpTransport` now accepts a discriminated `auth: { kind: 'bearer' | 'oauth', ... }` option. The legacy `bearerToken` field is preserved for back-compat.
  - 401 responses include an RFC 6750 `WWW-Authenticate` challenge with `error="invalid_token"` and an `error_description` mapped from a small, stable set of reasons (`token_expired`, `signature_invalid`, `claim_validation_failed`, `unknown_key`, `invalid_token`).
  - `mcpolyglot serve` now renders `Auth: oauth · <issuer>` and `Audience: <aud>` instead of the bearer token line when running in OAuth mode.
  - `examples/http/README.md` documents the OAuth setup with a curl + client-credentials walkthrough.

  Adds `jose` (^5.9.6) as a direct dependency of `@mcpolyglot/core`.

### Patch Changes

- e7251dd: Policy rejections (`forbidden.*`, `rate_limited`, `timeout`) now return as MCP tool errors (`isError: true`, message prefixed with the code) instead of a generic `-32603` internal error. Postgres read-only violations (SQLSTATE 25006) map to `forbidden.read_only`. Denied columns are now also removed from a query result's `columns` list, not just from rows.

## 0.1.0

### Minor Changes

- aec2cdb: Wave 2: multi-DB + remote.
  - **@mcpolyglot/connector-sql**: add **MySQL/MariaDB dialect** with read-only enforcement. The session is opened with `SET TRANSACTION READ ONLY`, every `SELECT` gets a `MAX_EXECUTION_TIME` hint, and a `node-sql-parser` AST gate rejects any non-read top-level statement before it reaches the server.
  - **@mcpolyglot/connector-mongo**: new package. Sample-based schema inference, `list_collections` / `describe_collection` / `find` / `aggregate` primitives, `$out` and `$merge` aggregation stages rejected.
  - **@mcpolyglot/core**: new `StreamableHttpTransport` (`@mcpolyglot/core/transports/streamable-http`) wrapping the SDK's `StreamableHTTPServerTransport`. Bearer-token auth via constant-time comparison, `WWW-Authenticate` challenge on 401, `/healthz` endpoint, loud warning when bound to a non-loopback host.
  - **@mcpolyglot/cli**: `mcpolyglot serve --http` boots the HTTP transport, prints the URL/token banner, and respects `cfg.transport` when no flag is passed. Auto-generates a bearer token if none is configured.
  - **@mcpolyglot/config**: MySQL/MariaDB and Mongo source kinds are now wired through to real connectors instead of throwing.
