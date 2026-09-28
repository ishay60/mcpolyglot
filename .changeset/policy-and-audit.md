---
'@mcpolyglot/connector-sql': minor
'@mcpolyglot/core': minor
'@mcpolyglot/security': minor
'@mcpolyglot/config': minor
'@mcpolyglot/cli': minor
'@mcpolyglot/connector-mongo': patch
---

Policy layer for SQL sources (per-table access, column denies, row/timeout caps, dry-run; DDL and unscoped UPDATE/DELETE always blocked). Audit entries gain `agentId`, `decision`, and `reason`; audit sinks are now console (default), file, and webhook. **Behavior change:** the audit log no longer goes to `~/.mcpolyglot/audit.log` unless `audit.path` is set.

**Fixes:** the per-call timeout now cuts off handlers that ignore the abort signal (previously a hung MySQL/SQLite call never returned), and the concurrency cap now releases its slot when a call finishes (previously slots were held for 30s, so quick sequential calls hit "too many concurrent calls").
