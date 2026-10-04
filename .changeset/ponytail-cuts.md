---
'@mcpolyglot/core': minor
'@mcpolyglot/config': minor
'@mcpolyglot/security': minor
'@mcpolyglot/connector-sql': patch
'@mcpolyglot/connector-mongo': patch
'@mcpolyglot/connector-openapi': patch
'@mcpolyglot/cli': patch
---

Removed surface that did nothing:

- **Per-entity tools.** No connector ever generated any. Gone: `Connector.generatePerEntityTools`, `PerEntityConfig`, the server's `perEntity` option and the `perEntityTools` source field. A `perEntityTools` key left in a JSON/YAML config is ignored; in a typed `.ts` config, delete the line.
- **`security.wrapMode: 'minimal'`.** Use `'strict'` (default) or `'off'`.
- **`@mcpolyglot/security`**: `composeHooks` is removed (it had no callers), and the `ScopeGuard` class is now a `checkScopes(toolName, required, granted)` function.
- **`@mcpolyglot/testkit`** is no longer part of the repo; nothing used it.
