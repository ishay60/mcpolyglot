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
| Write, update, delete, or run DDL        | Default scopes are `schema:read` + `tables:read`. No shipped tool requires `tables:write`. Each dialect also opens a read-only session (below).                                                        |
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

What this does **not** cover: prompt injection can still steer the model into making allowed read calls it shouldn't, and data the agent is allowed to read can leave through the client. Scope the database role and the granted scopes to what the agent actually needs.

## Hardening checklist for self-hosting

- Run `mcpolyglot serve --http` behind a reverse proxy with TLS.
- Bind to `127.0.0.1` for single-user setups.
- Use a database role with read-only permissions even though mcpolyglot enforces read-only at the protocol level.
- Enable `tables:write` scope only on isolated dev databases.
- Ship the audit log somewhere durable (`audit.path` or `audit.webhookUrl`) and review it periodically.

## Known limitations (alpha)

- The current rate limiter is in-process only.
- The HTTP transport defaults to a shared bearer token. OAuth mode verifies JWTs (signature, `iss`, `aud`, `exp`) but does not map token claims to scopes yet.
- Per-table write tools (Wave 3) will require explicit scope opt-in and do not yet support row-level filters.
