# @mcpolyglot/cli

The `mcpolyglot` command-line interface. Scaffolds a config, validates connectivity, lists tools, and serves the MCP server over stdio or Streamable HTTP.

```bash
npx @mcpolyglot/cli init       # interactive wizard
npx @mcpolyglot/cli doctor     # validate config, ping sources, list tools
npx @mcpolyglot/cli tools      # list tools mcpolyglot would expose
npx @mcpolyglot/cli serve      # start the MCP server (stdio)
npx @mcpolyglot/cli serve --http --port 7337   # start over Streamable HTTP
```

## Commands

| Command  | Purpose                                                                    |
| -------- | -------------------------------------------------------------------------- |
| `init`   | Interactively scaffold an `mcpolyglot.config.ts` in the current directory. |
| `doctor` | Load + validate config, resolve secrets, ping each source, list tools.     |
| `tools`  | Print every tool mcpolyglot would expose for the current config.           |
| `serve`  | Start the server. `--http` flips to Streamable HTTP with bearer auth.      |
| `token`  | `token create <agentId>` mints a per-agent token; `token hash` hashes one. |

`serve --http` prints the bearer token, MCP URL, and `/healthz` URL on stderr. Pin the token in your config (`transport.auth.token`) for stable deployments; omit it to mint a fresh token on each start.

## Multiple agents over HTTP

Give each agent its own token, sources and scopes. Tokens are stored only as sha256 hashes:

```bash
mcpolyglot token create analyst       # prints the token once, its hash, and a config snippet
echo -n "$TOKEN" | mcpolyglot token hash
```

```ts
agents: [
  {
    id: 'analyst',
    tokens: [{ hash: '<sha256 hex>', label: '2026-09' }],
    scopes: ['schema:read', 'tables:read', 'query:raw'],
    sources: { 'pg.main': { policy: { tables: { users: 'none' } } } },
  },
],
```

- An agent sees only tools of the sources listed under it, and only tools its scopes fully cover. `scopes` defaults to, and is capped at, the union of those sources' scopes.
- A per-agent `policy` can only **narrow** the source's `policy`: per table the most restrictive access wins, deny lists are combined, and caps take the smaller value. An agent can't re-open a table the source hides or gain writes the source doesn't grant. The reverse also holds: a table the agent's policy doesn't list falls to its `defaultAccess` (at most `read`), so an agent that should keep a source's write access must list that table as `write` again. It gets its own connector, so its own DB connection; sources listed without a policy share the main one.
- The token decides the audit `agentId`; the `x-mcpolyglot-agent` header is ignored when `agents` is set. Unknown or revoked tokens get `401`.
- Rotate: add the new hash, move the client over, set `revoked: true` on the old one (or delete it), restart `serve`. There is no hot reload.
- `agents` needs bearer auth (not OAuth) and is ignored under stdio (single local user). `doctor` lists what each agent can and can't use.

Stdio servers must keep stdout clean, so all CLI output goes to stderr.

## Docs

- Full README → https://github.com/ishay60/mcpolyglot
- Architecture → https://github.com/ishay60/mcpolyglot/blob/develop/ARCHITECTURE.md
- Examples → https://github.com/ishay60/mcpolyglot/tree/develop/examples

MIT licensed.
