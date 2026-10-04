---
'@mcpolyglot/core': minor
'@mcpolyglot/connector-sql': minor
'@mcpolyglot/connector-mongo': patch
'@mcpolyglot/connector-openapi': patch
'@mcpolyglot/cli': patch
---

**Fix:** each source's `limits` (row cap, timeout, byte cap) now apply to that source's tools. Previously the first source's limits were used for every tool and the others were ignored. `McpolyglotServer` takes `security.limits`, keyed by connector id.

`Connector.introspect()` and `SchemaSnapshot` are replaced by an optional `Connector.diagnose()`, which returns what `doctor` shows for a source: labelled facts and problems. The SQL connector reports its policy against the live schema and risky database privileges there; `SqlConnector.auditPrivileges()` is gone and `checkPolicy` is now exported from `@mcpolyglot/connector-sql`. `doctor` output is unchanged.
