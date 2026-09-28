# @mcpolyglot/connector-sql

SQL connector for [mcpolyglot](https://github.com/ishay60/mcpolyglot). One package, three dialects: **Postgres**, **MySQL/MariaDB**, and **SQLite**. Read-only by default with per-dialect enforcement at the database boundary.

## Tools exposed

For every SQL source mcpolyglot generates:

- `<id>.list_tables` — every table across non-system schemas, with columns.
- `<id>.describe_table` — one table's columns, types, and primary key.
- `<id>.query` — read-only SQL with parameterized args, row cap, and timeout.

(Opt-in per-table tools like `users.find_by_email` are scaffolded by `mcpolyglot init` and land fully in Wave 3.)

## How read-only is enforced

| Dialect  | Enforcement                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------- |
| Postgres | `BEGIN READ ONLY` transaction; rolled back at the end of every call.                                          |
| SQLite   | `PRAGMA query_only = 1`; database opened read-only when possible.                                             |
| MySQL    | AST gate (`node-sql-parser` mysql grammar) + `SET SESSION TRANSACTION READ ONLY` + `MAX_EXECUTION_TIME` hint. |

The AST gate matters on MySQL because `SET TRANSACTION READ ONLY` is partially honored — the parser refuses anything whose top-level statement isn't a read.

## Policy layer

Every `query` call is parsed (`node-sql-parser`, per-dialect grammar) and checked against the source's `policy` **before** it reaches the database. Denials come back as `forbidden.policy` with a specific reason.

```ts
policy: {
  tables: { users: 'read', orders: 'write', 'public.secrets': 'none' },
  defaultAccess: 'read',            // 'read' | 'none' — never 'write'
  denyColumns: ['users.password_hash', '*.ssn'],
  maxRows: 100,                     // min'd with limits.rowCap
  statementTimeoutMs: 5000,         // min'd with limits.timeoutMs
  maxWritesPerCall: 1,              // reserved for the write tool
}
```

Rules (each has a case in `src/__tests__/policy.test.ts`):

- Unparseable SQL is denied. So is more than one statement per call.
- Anything other than `SELECT`/`INSERT`/`UPDATE`/`DELETE` is always denied: DDL, `GRANT`, `TRUNCATE`, `SET`, and so on.
- `UPDATE`/`DELETE` without `WHERE` is denied.
- Every table referenced anywhere (joins, subqueries, `INSERT … SELECT`) is checked. `none` tables are denied and hidden from `list_tables`. Writes need an explicit `write` entry.
- When several policy keys could match a table (`users` and `public.users`), the most restrictive wins.
- A denied column is blocked wherever it appears: select list, `WHERE`, subqueries, aliased tables. `SELECT *` is denied if it could expose one. With a `*.col` rule, that means every `SELECT *`. Denied columns are also stripped from `list_tables`/`describe_table`.
- `dryRun: true` returns `{ decision }` without executing.

Known limits:

- The policy sees tables and columns, not functions, so `SELECT pg_read_file(...)` passes the classifier. Enforce that with the DB role's privileges.
- Writes that pass policy are still rejected, because the connection is read-only at the DB level. This is covered by a test. The write tool (with `maxWritesPerCall`) arrives with the DB-side work.

## Drivers are optional deps

The dialect drivers (`pg`, `mysql2`, `better-sqlite3`) are declared as `optionalDependencies`. Install only what you use.

## Docs

- Architecture → https://github.com/ishay60/mcpolyglot/blob/develop/ARCHITECTURE.md
- Examples →
  - [examples/postgres](https://github.com/ishay60/mcpolyglot/tree/develop/examples/postgres)
  - [examples/mysql](https://github.com/ishay60/mcpolyglot/tree/develop/examples/mysql)
  - [examples/sqlite](https://github.com/ishay60/mcpolyglot/tree/develop/examples/sqlite)

MIT licensed.
