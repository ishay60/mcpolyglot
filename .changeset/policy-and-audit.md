---
'@mcpolyglot/connector-sql': minor
'@mcpolyglot/core': minor
'@mcpolyglot/security': minor
'@mcpolyglot/config': minor
'@mcpolyglot/cli': minor
---

Policy layer for SQL sources (per-table access, column denies, row/timeout caps, dry-run; DDL and unscoped UPDATE/DELETE always blocked). Audit entries gain `agentId`, `decision`, and `reason`; audit sinks are now console (default), file, and webhook. **Behavior change:** the audit log no longer goes to `~/.mcpolyglot/audit.log` unless `audit.path` is set.
