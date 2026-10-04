# @mcpolyglot/connector-openapi

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
