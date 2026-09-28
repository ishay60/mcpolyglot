---
'@mcpolyglot/connector-sql': minor
'@mcpolyglot/cli': minor
---

SQL classifier hardening. Whole-row references (`SELECT u FROM users u`, `to_jsonb(u)`, `json_agg(u)`, `u::text`) are now checked against `denyColumns`, and denied keys are stripped from JSON/record values in query results as a second layer. `SELECT ... INTO`, server-access functions (`pg_read_file`, `pg_ls_dir`, `lo_import`, `dblink*`, `pg_sleep`, `LOAD_FILE`, `SLEEP`, `load_extension`, ...), system catalogs, and `UPDATE`/`DELETE` whose `WHERE` names no column are denied. `mcpolyglot doctor` fails when the database user is a superuser or holds server file privileges.
