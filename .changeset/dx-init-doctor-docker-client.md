---
'@mcpolyglot/cli': minor
'@mcpolyglot/client': minor
'@mcpolyglot/core': patch
'@mcpolyglot/config': patch
---

`mcpolyglot init <url>` introspects a database and writes a config with a read-only policy: every table `read`, `defaultAccess: 'none'`, and suggested `denyColumns` from column names. `mcpolyglot doctor` now validates each SQL policy against the live schema (unknown tables and columns are errors) and lists readable, writable, and hidden tables and columns. New `@mcpolyglot/client` package: typed `listTables` / `query` over HTTP with policy denials as `McpolyglotDeniedError`. A root `Dockerfile` and `examples/docker-compose` ship too.

**Fixes:** the Streamable HTTP transport answered only the first request; every later one returned 500. It now builds a fresh MCP server and transport per request. `doctor` no longer fails to connect when a source URL is a `${env:...}` reference: the credential check left a global regex's `lastIndex` set, so the URL was never resolved. `serve --http` no longer prints a bearer token that came from config.
