# @mcpolyglot/connector-sql

## 0.4.0

### Minor Changes

- 61e5457: **Fix:** each source's `limits` (row cap, timeout, byte cap) now apply to that source's tools. Previously the first source's limits were used for every tool and the others were ignored. `McpolyglotServer` takes `security.limits`, keyed by connector id.

  `Connector.introspect()` and `SchemaSnapshot` are replaced by an optional `Connector.diagnose()`, which returns what `doctor` shows for a source: labelled facts and problems. The SQL connector reports its policy against the live schema and risky database privileges there; `SqlConnector.auditPrivileges()` is gone and `checkPolicy` is now exported from `@mcpolyglot/connector-sql`. `doctor` output is unchanged.

### Patch Changes

- Updated dependencies [61e5457]
  - @mcpolyglot/core@0.5.0

## 0.3.1

### Patch Changes

- ea53e8f: Removed surface that did nothing:

  - **Per-entity tools.** No connector ever generated any. Gone: `Connector.generatePerEntityTools`, `PerEntityConfig`, the server's `perEntity` option and the `perEntityTools` source field. A `perEntityTools` key left in a JSON/YAML config is ignored; in a typed `.ts` config, delete the line.
  - **`security.wrapMode: 'minimal'`.** Use `'strict'` (default) or `'off'`.
  - **`@mcpolyglot/security`**: `composeHooks` is removed (it had no callers), and the `ScopeGuard` class is now a `checkScopes(toolName, required, granted)` function.
  - **`@mcpolyglot/testkit`** is no longer part of the repo; nothing used it.

- Updated dependencies [ea53e8f]
  - @mcpolyglot/core@0.4.0

## 0.3.0

### Minor Changes

- 03059f1: SQL classifier hardening. Whole-row references (`SELECT u FROM users u`, `to_jsonb(u)`, `json_agg(u)`, `u::text`) are now checked against `denyColumns`, and denied keys are stripped from JSON/record values in query results as a second layer. `SELECT ... INTO`, server-access functions (`pg_read_file`, `pg_ls_dir`, `lo_import`, `dblink*`, `pg_sleep`, `LOAD_FILE`, `SLEEP`, `load_extension`, ...), system catalogs, and `UPDATE`/`DELETE` whose `WHERE` names no column are denied. `mcpolyglot doctor` fails when the database user is a superuser or holds server file privileges.
- 24d8fa2: SQL sources open a DB-level read-only connection unless the policy grants a `write` table. New `<id>.execute` tool (scope `tables:write`, only registered with a `write` table): one INSERT/UPDATE/DELETE per call in a transaction, rolled back above `maxWritesPerCall`, with `dryRun` and an optional `idempotencyKey` (policy `idempotencyWindowMinutes`, default 10). New per-source `pool: { max, idleTimeoutMs }` and `maxConcurrentQueries` (over-cap calls are rejected with `rate_limited`). `SqlDialect` gains `runWrite` and `connect({ writable })`.
- 54d6b1b: Policy layer for SQL sources (per-table access, column denies, row/timeout caps, dry-run; DDL and unscoped UPDATE/DELETE always blocked). Audit entries gain `agentId`, `decision`, and `reason`; audit sinks are now console (default), file, and webhook. **Behavior change:** the audit log no longer goes to `~/.mcpolyglot/audit.log` unless `audit.path` is set.

  **Fixes:** the per-call timeout now cuts off handlers that ignore the abort signal (previously a hung MySQL/SQLite call never returned), and the concurrency cap now releases its slot when a call finishes (previously slots were held for 30s, so quick sequential calls hit "too many concurrent calls").

### Patch Changes

- Updated dependencies [24d8fa2]
- Updated dependencies [24d8fa2]
- Updated dependencies [54d6b1b]
  - @mcpolyglot/core@0.3.0

## 0.2.0

### Minor Changes

- b98aaf6: Refresh CLI UI in a Copilot-CLI flavor and bump zod to v4.

  - New UI primitives in `@mcpolyglot/cli`: a boxed `headerBar` with a sub-command pill, pill-chip status indicators (`[ OK ]`, `[ ERR ]`, `[ READY ]`), section dividers, a `panel` for "next steps" callouts, a `footerBar` for hints, and a `step(n/total)` indicator for the `init` wizard.
  - `doctor`, `serve`, `tools`, and `init` adopt the new layout. The light `banner` is retained for compatibility.
  - `@mcpolyglot/core` now uses zod v4's built-in `z.toJSONSchema()` instead of the `zod-to-json-schema` package, dropping one dep.
  - `@mcpolyglot/config`, `@mcpolyglot/connector-sql`, and `@mcpolyglot/connector-mongo` upgraded to zod 4. `ZodTypeAny` was replaced with a permissive `AnyZodSchema` alias in core so existing connector handlers keep working without explicit generic annotations.
  - `@mcpolyglot/cli` upgraded `@clack/prompts` to v1 (validate signatures now allow `undefined`).

### Patch Changes

- e7251dd: Policy rejections (`forbidden.*`, `rate_limited`, `timeout`) now return as MCP tool errors (`isError: true`, message prefixed with the code) instead of a generic `-32603` internal error. Postgres read-only violations (SQLSTATE 25006) map to `forbidden.read_only`. Denied columns are now also removed from a query result's `columns` list, not just from rows.
- Updated dependencies [b98aaf6]
- Updated dependencies [6f8b1d2]
- Updated dependencies [e7251dd]
  - @mcpolyglot/core@0.2.0

## 0.1.0

### Minor Changes

- aec2cdb: Wave 2: multi-DB + remote.
  - **@mcpolyglot/connector-sql**: add **MySQL/MariaDB dialect** with read-only enforcement. The session is opened with `SET TRANSACTION READ ONLY`, every `SELECT` gets a `MAX_EXECUTION_TIME` hint, and a `node-sql-parser` AST gate rejects any non-read top-level statement before it reaches the server.
  - **@mcpolyglot/connector-mongo**: new package. Sample-based schema inference, `list_collections` / `describe_collection` / `find` / `aggregate` primitives, `$out` and `$merge` aggregation stages rejected.
  - **@mcpolyglot/core**: new `StreamableHttpTransport` (`@mcpolyglot/core/transports/streamable-http`) wrapping the SDK's `StreamableHTTPServerTransport`. Bearer-token auth via constant-time comparison, `WWW-Authenticate` challenge on 401, `/healthz` endpoint, loud warning when bound to a non-loopback host.
  - **@mcpolyglot/cli**: `mcpolyglot serve --http` boots the HTTP transport, prints the URL/token banner, and respects `cfg.transport` when no flag is passed. Auto-generates a bearer token if none is configured.
  - **@mcpolyglot/config**: MySQL/MariaDB and Mongo source kinds are now wired through to real connectors instead of throwing.

### Patch Changes

- Updated dependencies [aec2cdb]
  - @mcpolyglot/core@0.1.0
