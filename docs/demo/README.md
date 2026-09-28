# CLI demo

Real captures of the mcpolyglot CLI against a small sample SQLite database. These files are the project's "screenshot" — they survive renames, link rot, and grayscale terminals, and they're easy to diff in PRs when the CLI output changes.

Regenerate with:

```bash
pnpm build
bash docs/demo/regenerate.sh
```

The bearer token, session UUID, and temp paths are scrubbed automatically; only latency numbers vary between runs.

## Captures

- [`help.txt`](./help.txt) — `mcpolyglot --help`. Banner + commands.
- [`doctor.txt`](./doctor.txt) — `mcpolyglot doctor`. Validates config, pings the source, lists generated tools and the scopes each one needs.
- [`tools.txt`](./tools.txt) — `mcpolyglot tools`. Tabular preview of every tool a config would expose, with read-only / scope columns.
- [`agent-call.txt`](./agent-call.txt) — an MCP client (what Claude/Cursor are) calling the `query` tool over stdio: emails redacted, `password_hash` dropped, result wrapped as untrusted data, and an `UPDATE` rejected. Driven by [`agent-call.mjs`](./agent-call.mjs).
- [`serve-http.txt`](./serve-http.txt) — `mcpolyglot serve --http`. Streamable HTTP startup banner, including the structured JSON logs (`http.listening`, `mcpolyglot.started`) and the "ready in 20 ms" line.

## Sample data

The `regenerate.sh` script creates a small SQLite database with `users` and `orders` tables. The config redacts `users.password_hash` so you can verify column-level deny lists actually drop the field from any `query` result.
