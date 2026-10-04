# OpenAPI example

A minimal mcpolyglot config that exposes a hand-picked slice of the GitHub REST API to Claude Desktop, Cursor, or Claude Code over stdio. The agent can call the operations in [`openapi.yaml`](./openapi.yaml) and nothing else.

## 1. Install

```bash
npx @mcpolyglot/cli --version
```

## 2. Configure

Nothing to set: the two operations here are public. For private repositories or a higher rate limit, switch `auth` in [`mcpolyglot.config.ts`](./mcpolyglot.config.ts) to the commented `bearer` line and export `GITHUB_TOKEN`.

To point this at your own API, replace `openapi.yaml` with your spec (JSON or YAML, file or URL) and set `baseUrl`.

## 3. Validate

```bash
npx @mcpolyglot/cli doctor --config ./mcpolyglot.config.ts
```

You should see the `github` source and its three tools.

## 4. Wire into your agent

- **Claude Desktop** — copy [`claude-desktop.json`](./claude-desktop.json) into `~/Library/Application Support/Claude/claude_desktop_config.json` (replace the absolute path) and restart.
- **Cursor** — copy [`cursor.json`](./cursor.json) into `~/.cursor/mcp.json`.
- **Claude Code** — run [`./claude-code.sh`](./claude-code.sh).

Then ask: _"What are the five most recent open issues on ishay60/mcpolyglot?"_

## What you get

| Tool                        | Description                                                        |
| --------------------------- | ------------------------------------------------------------------ |
| `github.list_operations`    | The callable operations: `getRepo` and `listIssues`.               |
| `github.describe_operation` | One operation's parameters and request body schema.                |
| `github.call`               | Call an operation by `operationId` with `path` and `query` values. |

## What the agent cannot do

1. Call `deleteRepo`. It is in the spec, but `DELETE` is not in `allowMethods`, so it is neither listed nor callable.
2. Call any GitHub endpoint that is not in the spec, or reach any host other than `baseUrl`. Redirects are refused.
3. Send a parameter the spec does not declare, or any header. The token, if you set one, comes from config.
4. Pull an unbounded response: the body is cut at `limits.maxBytes`.

Results are redacted, size-capped, and wrapped in an `<mcpolyglot-data>` "untrusted-data" block before reaching the model.
