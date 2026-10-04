# @mcpolyglot/connector-mongo

## 0.2.3

### Patch Changes

- 61e5457: **Fix:** each source's `limits` (row cap, timeout, byte cap) now apply to that source's tools. Previously the first source's limits were used for every tool and the others were ignored. `McpolyglotServer` takes `security.limits`, keyed by connector id.

  `Connector.introspect()` and `SchemaSnapshot` are replaced by an optional `Connector.diagnose()`, which returns what `doctor` shows for a source: labelled facts and problems. The SQL connector reports its policy against the live schema and risky database privileges there; `SqlConnector.auditPrivileges()` is gone and `checkPolicy` is now exported from `@mcpolyglot/connector-sql`. `doctor` output is unchanged.

- Updated dependencies [61e5457]
  - @mcpolyglot/core@0.5.0

## 0.2.2

### Patch Changes

- ea53e8f: Removed surface that did nothing:

  - **Per-entity tools.** No connector ever generated any. Gone: `Connector.generatePerEntityTools`, `PerEntityConfig`, the server's `perEntity` option and the `perEntityTools` source field. A `perEntityTools` key left in a JSON/YAML config is ignored; in a typed `.ts` config, delete the line.
  - **`security.wrapMode: 'minimal'`.** Use `'strict'` (default) or `'off'`.
  - **`@mcpolyglot/security`**: `composeHooks` is removed (it had no callers), and the `ScopeGuard` class is now a `checkScopes(toolName, required, granted)` function.
  - **`@mcpolyglot/testkit`** is no longer part of the repo; nothing used it.

- Updated dependencies [ea53e8f]
  - @mcpolyglot/core@0.4.0

## 0.2.1

### Patch Changes

- 54d6b1b: Policy layer for SQL sources (per-table access, column denies, row/timeout caps, dry-run; DDL and unscoped UPDATE/DELETE always blocked). Audit entries gain `agentId`, `decision`, and `reason`; audit sinks are now console (default), file, and webhook. **Behavior change:** the audit log no longer goes to `~/.mcpolyglot/audit.log` unless `audit.path` is set.

  **Fixes:** the per-call timeout now cuts off handlers that ignore the abort signal (previously a hung MySQL/SQLite call never returned), and the concurrency cap now releases its slot when a call finishes (previously slots were held for 30s, so quick sequential calls hit "too many concurrent calls").

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
