# Security Policy

## Reporting a Vulnerability

Please report vulnerabilities **privately** by opening a [GitHub security advisory](https://github.com/ishay60/mcpolyglot/security/advisories/new). Do not file public issues for security problems.

We aim to acknowledge reports within 72 hours and to disclose fixes within 90 days.

## Scope

mcpolyglot's threat model assumes:

1. **The MCP client is trusted** (Claude Desktop, Cursor, Claude Code on the user's machine).
2. **The model is untrusted.** Tool results are wrapped before reaching the model, but no LLM can be fully sandboxed against prompt injection. Treat agent actions as actions taken by the model, not by you.
3. **Database content is untrusted.** Tool results are passed through redaction and an "untrusted data" wrapper before being returned to the client.
4. **Secrets are resolved at runtime** via `${env:…}`, `${file:…}`, or `${keychain:…}`. `mcpolyglot doctor` warns on literal credentials in config.

## What an agent cannot do

These are enforced by the server, not requested of the model. Every tool call runs through the same fixed pipeline (`scope → rate limit → timeout → handler → redact → size cap → untrusted-wrap → audit`) in `McpolyglotServer.executeTool`; connectors cannot skip a phase.

| The agent cannot…                        | Enforced by                                                                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Write, update, delete, or run DDL        | Default scopes are `schema:read` + `tables:read`. Only `<id>.execute` needs `tables:write`, and it exists only when the policy marks a table `write`; otherwise the DB connection itself is read-only. |
| Slip a write past the SQL tool           | Postgres `BEGIN READ ONLY`; SQLite `query_only` pragma; MySQL AST gate + `SET TRANSACTION READ ONLY`. The database rejects it even if parsing is fooled.                                               |
| Write through a Mongo pipeline           | Only `find` / `aggregate` are exposed; `$out` and `$merge` stages are rejected with `forbidden.read_only`.                                                                                             |
| Call a tool its session wasn't granted   | Scope guard (phase 1) throws `ScopeError` before the handler runs. Raw queries need the explicit `query:raw` scope.                                                                                    |
| Hammer the database                      | Token-bucket rate limit per session per tool, plus a concurrency cap.                                                                                                                                  |
| Run a long query                         | Per-call timeout (default 10 s, max 60 s) aborts the handler.                                                                                                                                          |
| Pull the whole table                     | Row cap (default 200, max 10 000) and byte cap (default 256 KiB); oversized results are truncated and flagged.                                                                                         |
| Read secrets that happen to be in rows   | Redaction of emails, JWTs, AWS keys, GitHub tokens, SSNs, and card numbers, plus per-column deny lists (e.g. `public.users.password_hash`).                                                            |
| Get DB content treated as instructions   | Every result is wrapped in `<mcpolyglot-data>` so the client/model sees it as untrusted data.                                                                                                          |
| Act without a trace                      | Every call, including failures, appends a JSONL audit line (session, agent id, tool, allow/deny decision + reason, scopes, args hash, duration, rows, redactions). Raw args and rows are never logged. |
| Reach the HTTP transport unauthenticated | Bearer token (auto-generated if unset) or OAuth JWT verified against the issuer's JWKS (`iss`, `aud`, `exp`). Binds to loopback by default and warns otherwise.                                        |

### Where each claim is tested

If a guardrail is claimed here or in the README, a test fails when it stops being true. CI runs all of them against real Postgres 16, MySQL 8.4 and SQLite, and fails if any test is skipped.

| Claim                                                                                                                              | Test                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| DDL, multi-statement, unparseable SQL always denied; `UPDATE`/`DELETE` need `WHERE`                                                | `packages/connector-sql/src/__tests__/policy.test.ts`                                        |
| `SELECT ... INTO`, server-access functions (`pg_read_file`, `LOAD_FILE`, `dblink`, ...), system catalogs denied                    | `policy.test.ts`                                                                             |
| Whole-row references (`SELECT u FROM users u`, `to_jsonb(u)`, `u::text`) hit `denyColumns`; denied keys stripped from JSON results | `policy.test.ts`                                                                             |
| Per-table `read`/`write`/`none`, most-restrictive match, no default write                                                          | `policy.test.ts`                                                                             |
| Denied columns blocked in any position and hidden from `list_tables`                                                               | `policy.test.ts`, `dialects.integration.test.ts`, `sqlite.integration.test.ts`               |
| DB-level read-only catches a write the policy allowed                                                                              | `dialects.integration.test.ts` (Postgres, MySQL), `sqlite.integration.test.ts`               |
| Dry-run never executes                                                                                                             | `sqlite.integration.test.ts`                                                                 |
| No write tables: connection refuses a raw write that bypasses the tools                                                            | `dialects.integration.test.ts` (Postgres, MySQL), `sqlite.integration.test.ts`               |
| `execute` registered only with a `write` table                                                                                     | `dialects.integration.test.ts`, `sqlite.integration.test.ts`                                 |
| `execute` over `maxWritesPerCall` rolls back                                                                                       | `dialects.integration.test.ts`, `sqlite.integration.test.ts`                                 |
| Idempotent replay doesn't re-execute; key reuse with other args errors                                                             | `dialects.integration.test.ts`, `sqlite.integration.test.ts`                                 |
| `maxConcurrentQueries` rejects with `rate_limited`                                                                                 | `dialects.integration.test.ts`, `sqlite.integration.test.ts`                                 |
| Mongo `$out` / `$merge` rejected                                                                                                   | `packages/connector-mongo/src/__tests__/aggregate-gate.test.ts`                              |
| OpenAPI: only spec operations with an allowed method are callable                                                                  | `packages/connector-openapi/src/__tests__/connector.test.ts`                                 |
| OpenAPI: requests stay under `baseUrl`; path traversal and undeclared parameters rejected; redirects refused                       | `packages/connector-openapi/src/__tests__/connector.test.ts`                                 |
| OpenAPI: credentials come from config only; response read is capped at `maxBytes`                                                  | `packages/connector-openapi/src/__tests__/connector.test.ts`                                 |
| Scope check runs before the handler                                                                                                | `packages/core/src/__tests__/pipeline.test.ts`                                               |
| Per-call timeout cuts off a hung handler                                                                                           | `pipeline.test.ts`, and the DB-side timeout in `dialects.integration.test.ts`                |
| Rate limit and concurrency cap; slot released on every outcome                                                                     | `packages/security/src/__tests__/rate-limiter.test.ts`, `pipeline.test.ts`                   |
| Row cap and byte cap truncate and flag                                                                                             | `sqlite.integration.test.ts`, `dialects.integration.test.ts`, `wrap.test.ts`                 |
| Each built-in redaction pattern                                                                                                    | `redactor.test.ts`                                                                           |
| Results wrapped as untrusted data                                                                                                  | `wrap.test.ts`                                                                               |
| Audit: every call, allow/deny/error, agent id, no raw args or rows, scrubbed text                                                  | `pipeline.test.ts`, `packages/security/src/__tests__/audit.test.ts`                          |
| Every row of the `examples/*/README.md` tables (read-only analytics, spend policy, multi-agent)                                    | `packages/cli/src/__tests__/examples.test.ts`                                                |
| HTTP: bearer required, OAuth `iss`/`aud`/`exp`/key checks, loopback default                                                        | `streamable-http.test.ts`, `oauth.test.ts`, `packages/config/src/__tests__/defaults.test.ts` |
| Agent tokens: sha256-hashed, constant-time lookup; revoked/unknown → 401                                                           | `streamable-http.test.ts`, `packages/cli/src/__tests__/agents.test.ts`                       |
| Per-agent sources, scopes and policy filter `tools/list` and `tools/call`                                                          | `agents.test.ts`                                                                             |
| A per-agent policy only narrows the source policy (never widens tables, writes, caps)                                              | `policy.test.ts` (`narrowPolicy`), `agents.test.ts`                                          |
| Audit `agentId` comes from the token, not the `x-mcpolyglot-agent` header                                                          | `agents.test.ts`                                                                             |
| Without `agents`, single shared token behavior is unchanged                                                                        | `agents.test.ts`, `streamable-http.test.ts`                                                  |
| Literal credentials flagged                                                                                                        | `secrets.test.ts`                                                                            |

What this does **not** cover: prompt injection can still steer the model into making allowed read calls it shouldn't, and data the agent is allowed to read can leave through the client. Scope the database role and the granted scopes to what the agent actually needs.

The SQL classifier is defense-in-depth, not the control. It parses what the grammar understands and denies what it cannot see, but a parser cannot know every function an extension adds or every way a row can be serialized. The database user's grants are the control: a user without `pg_read_server_files`, `FILE`, superuser, or write grants makes a classifier bypass harmless. `mcpolyglot doctor` fails when the connected user holds any of those.

Idempotency keys and rate-limit counters live in process memory. They do not survive a restart and are not shared between replicas of the HTTP transport. Run one replica per source, or treat `idempotencyKey` as best-effort behind a load balancer.

## Hardening checklist for self-hosting

- Run `mcpolyglot serve --http` behind a reverse proxy with TLS.
- Bind to `127.0.0.1` for single-user setups.
- Use a database role with read-only permissions even though mcpolyglot enforces read-only at the protocol level. Never a superuser, and never one in `pg_read_server_files` or with MySQL `FILE`; `mcpolyglot doctor` checks this.
- Enable `tables:write` scope only on isolated dev databases.
- Ship the audit log somewhere durable (`audit.path` or `audit.webhookUrl`) and review it periodically.

## Known limitations (alpha)

- The current rate limiter is in-process only.
- A timed-out call returns to the agent at the limit, but the abandoned query keeps running until the database's own timeout stops it. SQLite (`better-sqlite3`) is synchronous and blocks the process until the query finishes, so a slow SQLite query cannot be interrupted.
- The HTTP transport defaults to a shared bearer token; configure `agents` for per-agent tokens, sources, scopes and policy. Without `agents`, the audit `agentId` is client-asserted (header / `clientInfo`). OAuth mode verifies JWTs (signature, `iss`, `aud`, `exp`) but does not map token claims to scopes or agents yet, and cannot be combined with `agents`.
- Agent config (including revocation) is read at startup; restart `serve` after revoking a token. Rate limits are per agent but still in-process.
