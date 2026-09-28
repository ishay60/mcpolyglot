# @mcpolyglot/security

## 0.0.3

### Patch Changes

- e7251dd: Policy rejections (`forbidden.*`, `rate_limited`, `timeout`) now return as MCP tool errors (`isError: true`, message prefixed with the code) instead of a generic `-32603` internal error. Postgres read-only violations (SQLSTATE 25006) map to `forbidden.read_only`. Denied columns are now also removed from a query result's `columns` list, not just from rows.
- Updated dependencies [b98aaf6]
- Updated dependencies [6f8b1d2]
- Updated dependencies [e7251dd]
  - @mcpolyglot/core@0.2.0

## 0.0.2

### Patch Changes

- Updated dependencies [aec2cdb]
  - @mcpolyglot/core@0.1.0
