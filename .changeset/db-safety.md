---
'@mcpolyglot/connector-sql': minor
'@mcpolyglot/config': minor
'@mcpolyglot/cli': minor
---

SQL sources open a DB-level read-only connection unless the policy grants a `write` table. New `<id>.execute` tool (scope `tables:write`, only registered with a `write` table): one INSERT/UPDATE/DELETE per call in a transaction, rolled back above `maxWritesPerCall`, with `dryRun` and an optional `idempotencyKey` (policy `idempotencyWindowMinutes`, default 10). New per-source `pool: { max, idleTimeoutMs }` and `maxConcurrentQueries` (over-cap calls are rejected with `rate_limited`). `SqlDialect` gains `runWrite` and `connect({ writable })`.
