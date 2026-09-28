# @mcpolyglot/connector-sql

SQL connector for [mcpolyglot](https://github.com/ishay60/mcpolyglot). One package, three dialects: **Postgres**, **MySQL/MariaDB**, and **SQLite**. Read-only by default with per-dialect enforcement at the database boundary.

## Tools exposed

For every SQL source mcpolyglot generates:

- `<id>.list_tables` — every table across non-system schemas, with columns.
- `<id>.describe_table` — one table's columns, types, and primary key.
- `<id>.query` — read-only SQL with parameterized args, row cap, and timeout.

(Opt-in per-table tools like `users.find_by_email` are scaffolded by `mcpolyglot init` and land fully in Wave 3.)

## How read-only is enforced

Three layers, each enough on its own for the common case:

| Layer                             | Postgres                                     | MySQL                                                                | SQLite                                |
| --------------------------------- | -------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------- |
| Policy classifier (every dialect) | parses the SQL, denies before the DB sees it | same                                                                 | same                                  |
| Per call (`query`)                | `BEGIN READ ONLY`, rolled back               | AST gate + `START TRANSACTION READ ONLY` + `MAX_EXECUTION_TIME` hint | statement must be a reader            |
| Per connection (no `write` table) | `default_transaction_read_only=on`           | `SESSION TRANSACTION READ ONLY` on every pooled connection           | file opened `readonly` + `query_only` |

The MySQL AST gate matters because MySQL's transaction read-only mode doesn't cover everything. The connection layer is a session default, so a `SET` could undo it; the classifier blocks `SET`. A database role without write grants is still the real backstop.

## Policy layer

Every `query` call is parsed (`node-sql-parser`, per-dialect grammar) and checked against the source's `policy` **before** it reaches the database. Denials come back as `forbidden.policy` with a specific reason.

```ts
policy: {
  tables: { users: 'read', orders: 'write', 'public.secrets': 'none' },
  defaultAccess: 'read',            // 'read' | 'none' — never 'write'
  denyColumns: ['users.password_hash', '*.ssn'],
  maxRows: 100,                     // min'd with limits.rowCap
  statementTimeoutMs: 5000,         // min'd with limits.timeoutMs
  maxWritesPerCall: 1,              // execute rolls back above this many changed rows
  idempotencyWindowMinutes: 10,     // execute idempotencyKey memory
}
```

Rules (each has a case in `src/__tests__/policy.test.ts`):

- Unparseable SQL is denied. So is more than one statement per call.
- Anything other than `SELECT`/`INSERT`/`UPDATE`/`DELETE` is always denied: DDL, `GRANT`, `TRUNCATE`, `SET`, and so on.
- `UPDATE`/`DELETE` without `WHERE` is denied, as is a `WHERE` that names no column (`WHERE 1=1`). This catches a forgotten clause; a determined full-table write is stopped by `maxWritesPerCall` rolling it back, not by this check.
- `SELECT ... INTO OUTFILE/DUMPFILE` (MySQL) and `SELECT ... INTO table` (Postgres) are denied.
- Functions that reach the server's filesystem, other hosts, or the session itself are denied by name in every dialect: `pg_read_file`, `pg_ls_dir`, `lo_import`/`lo_export`, `dblink*`, `pg_sleep`, `LOAD_FILE`, `SLEEP`, `load_extension`, and so on (`DENIED_FUNCTIONS` in `policy.ts`). The list is a backstop; revoke the privileges at the database.
- System catalogs (`information_schema`, `pg_catalog`, `pg_*`, `mysql`, `performance_schema`, `sys`, `sqlite_*`) are denied under any `defaultAccess` unless a `tables` key names the table.
- Every table referenced anywhere (joins, subqueries, `INSERT … SELECT`) is checked. `none` tables are denied and hidden from `list_tables`. Writes need an explicit `write` entry.
- When several policy keys could match a table (`users` and `public.users`), the most restrictive wins.
- A denied column is blocked wherever it appears: select list, `WHERE`, subqueries, aliased tables. `SELECT *` is denied if it could expose one. With a `*.col` rule, that means every `SELECT *`. Denied columns are also stripped from `list_tables`/`describe_table`.
- A whole-row reference is treated like `SELECT *` on that table: `SELECT u FROM users u`, `to_jsonb(u)`, `json_agg(u)`, `row_to_json(users)`, `u::text`. Any bare identifier that matches a table name or alias in the query counts, so a column that shares its table's name is denied too when that table has denied columns.
- Second layer, after the query runs: any object or array value in the result has keys named like a denied column removed, at any depth. This is what stops a denied column that still arrives inside a JSON value the classifier could not attribute.
- `dryRun: true` returns `{ decision }` without executing.

Known limits:

- The function denylist is by name. A user-defined wrapper, an extension function not on the list, or `COPY ... TO PROGRAM` (blocked as non-SELECT) are examples of why the classifier is defense-in-depth. The database user's privileges are the control: `mcpolyglot doctor` fails when that user is a superuser, is in `pg_read_server_files`/`pg_write_server_files`/`pg_execute_server_program`, or holds MySQL `FILE`/`SUPER`/`ALL PRIVILEGES`.
- A whole-row value cast to text (`u::text`) is not JSON, so the output filter cannot strip fields from it; the classifier denies the reference instead. If a parser gap lets one through, the redactor still masks the built-in PII patterns.
- `query` never writes, even on a writable connection: Postgres/MySQL run it in a read-only transaction and SQLite refuses non-reader statements.

## Writes and connection safety

The connection's mode follows the policy:

- **No `write` table** (the default): the database itself refuses writes. Postgres pools set `default_transaction_read_only=on`, MySQL sets `SESSION TRANSACTION READ ONLY` on every new pool connection (a failed SET drops the connection), SQLite opens the file `readonly` with `query_only`. The `execute` tool is not registered.
- **At least one `write` table**: the connection is writable and `<id>.execute` appears (scope `tables:write`).

`execute` runs one `INSERT`/`UPDATE`/`DELETE` that `classify()` allows, inside a transaction, with `statementTimeoutMs`. If it changes more than `maxWritesPerCall` rows it rolls back and fails with `forbidden.policy` (the reason carries both counts). Success returns `{ rowsAffected }`, also in `metadata.rows`. `dryRun` works as in `query`.

`idempotencyKey` (optional): a retry with the same key within `idempotencyWindowMinutes` returns the first result without writing again. The same key with different `sql`/`params` fails with `invalid_argument`. Failed calls are not remembered. Keys live in process memory, per connector: a restart or a second replica forgets them.

Source-level limits:

```ts
{ id: 'pg.main', kind: 'postgres', url: '…',
  pool: { max: 4, idleTimeoutMs: 30000 },   // pg / mysql2 pool; SQLite ignores it
  maxConcurrentQueries: 8 }                 // query + execute in flight on this source
```

Calls over `maxConcurrentQueries` are **rejected** immediately with `rate_limited`, not queued, so the agent sees back-pressure instead of a hidden wait.

Known gaps: MySQL has no server-side timeout for DML, so `execute` uses the driver's client-side timeout (the server may run on briefly). SQLite checks the timeout after the statement finishes, then rolls back. A replayed idempotent call returns the old result even if the row has since changed.

## Drivers are optional deps

The dialect drivers (`pg`, `mysql2`, `better-sqlite3`) are declared as `optionalDependencies`. Install only what you use.

## Docs

- Architecture → https://github.com/ishay60/mcpolyglot/blob/develop/ARCHITECTURE.md
- Examples →
  - [examples/postgres](https://github.com/ishay60/mcpolyglot/tree/develop/examples/postgres)
  - [examples/mysql](https://github.com/ishay60/mcpolyglot/tree/develop/examples/mysql)
  - [examples/sqlite](https://github.com/ishay60/mcpolyglot/tree/develop/examples/sqlite)

MIT licensed.
