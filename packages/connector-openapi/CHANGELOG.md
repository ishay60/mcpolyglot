# @mcpolyglot/connector-openapi

## 0.1.2

### Patch Changes

- 61e5457: **Fix:** each source's `limits` (row cap, timeout, byte cap) now apply to that source's tools. Previously the first source's limits were used for every tool and the others were ignored. `McpolyglotServer` takes `security.limits`, keyed by connector id.

  `Connector.introspect()` and `SchemaSnapshot` are replaced by an optional `Connector.diagnose()`, which returns what `doctor` shows for a source: labelled facts and problems. The SQL connector reports its policy against the live schema and risky database privileges there; `SqlConnector.auditPrivileges()` is gone and `checkPolicy` is now exported from `@mcpolyglot/connector-sql`. `doctor` output is unchanged.

- Updated dependencies [61e5457]
  - @mcpolyglot/core@0.5.0

## 0.1.1

### Patch Changes

- ea53e8f: Removed surface that did nothing:

  - **Per-entity tools.** No connector ever generated any. Gone: `Connector.generatePerEntityTools`, `PerEntityConfig`, the server's `perEntity` option and the `perEntityTools` source field. A `perEntityTools` key left in a JSON/YAML config is ignored; in a typed `.ts` config, delete the line.
  - **`security.wrapMode: 'minimal'`.** Use `'strict'` (default) or `'off'`.
  - **`@mcpolyglot/security`**: `composeHooks` is removed (it had no callers), and the `ScopeGuard` class is now a `checkScopes(toolName, required, granted)` function.
  - **`@mcpolyglot/testkit`** is no longer part of the repo; nothing used it.

- Updated dependencies [ea53e8f]
  - @mcpolyglot/core@0.4.0

## 0.1.0

### Minor Changes

- c840340: New `@mcpolyglot/connector-openapi`: `kind: 'openapi'` sources now work. Exposes `<id>.list_operations`, `<id>.describe_operation` and `<id>.call` (scope `http:call`) for an OpenAPI 3 spec (JSON or YAML, file or URL). Only operations in the spec whose method is in `allowMethods` (default GET / HEAD / OPTIONS) can be called; requests are pinned to `baseUrl`, only declared path and query parameters are accepted, redirects are refused, and credentials come from config (`${env:...}` supported), never from the model.
