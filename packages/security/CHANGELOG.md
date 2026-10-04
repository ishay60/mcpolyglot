# @mcpolyglot/security

## 0.1.0

### Minor Changes

- 54d6b1b: Policy layer for SQL sources (per-table access, column denies, row/timeout caps, dry-run; DDL and unscoped UPDATE/DELETE always blocked). Audit entries gain `agentId`, `decision`, and `reason`; audit sinks are now console (default), file, and webhook. **Behavior change:** the audit log no longer goes to `~/.mcpolyglot/audit.log` unless `audit.path` is set.

  **Fixes:** the per-call timeout now cuts off handlers that ignore the abort signal (previously a hung MySQL/SQLite call never returned), and the concurrency cap now releases its slot when a call finishes (previously slots were held for 30s, so quick sequential calls hit "too many concurrent calls").

### Patch Changes

- Updated dependencies [24d8fa2]
- Updated dependencies [24d8fa2]
- Updated dependencies [54d6b1b]
  - @mcpolyglot/core@0.3.0

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
