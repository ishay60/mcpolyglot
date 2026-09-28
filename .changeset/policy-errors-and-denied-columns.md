---
'@mcpolyglot/core': patch
'@mcpolyglot/security': patch
'@mcpolyglot/connector-sql': patch
---

Policy rejections (`forbidden.*`, `rate_limited`, `timeout`) now return as MCP tool errors (`isError: true`, message prefixed with the code) instead of a generic `-32603` internal error. Postgres read-only violations (SQLSTATE 25006) map to `forbidden.read_only`. Denied columns are now also removed from a query result's `columns` list, not just from rows.
