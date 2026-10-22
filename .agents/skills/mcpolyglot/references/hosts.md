# Wiring mcpolyglot into each host

Two transports. **stdio**: the host spawns `npx -y @mcpolyglot/cli serve --config <abs path>`
per session; right for local IDEs. **Streamable HTTP**: one long-lived `serve --http` behind
TLS, clients send `Authorization: Bearer <token>`; required for claude.ai and ChatGPT, which
reach the server from the vendor's cloud and cannot see localhost.

Use an absolute config path. Pass secrets through the host's `env` block, never in args.

## Claude Code (stdio)

```bash
claude mcp add mcpolyglot -e DATABASE_URL="$DATABASE_URL" -- npx -y @mcpolyglot/cli serve --config /abs/path/mcpolyglot.config.ts
```

`--scope project` writes `.mcp.json` for the team. For a running HTTP server:

```bash
claude mcp add --transport http mcpolyglot https://mcp.example.com/mcp --header "Authorization: Bearer $MCPOLYGLOT_BEARER_TOKEN"
```

To use this skill in Claude Code too, copy or symlink `.agents/skills/mcpolyglot` into
`.claude/skills/` (project) or `~/.claude/skills/` (personal).

## Claude Desktop (stdio)

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or
`%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "mcpolyglot": {
      "command": "npx",
      "args": ["-y", "@mcpolyglot/cli", "serve", "--config", "/abs/path/mcpolyglot.config.ts"],
      "env": { "DATABASE_URL": "postgres://user:pass@localhost:5432/db" }
    }
  }
}
```

Restart Claude Desktop. Local servers configured here are not available in claude.ai or Cowork.

## claude.ai chat (Streamable HTTP, custom connector)

1. Run `serve --http` on a public HTTPS URL (the repo `Dockerfile` or `examples/docker-compose`
   behind Caddy/nginx/an ALB). Bind to loopback and let the proxy terminate TLS.
2. Pin the token: `MCPOLYGLOT_BEARER_TOKEN` in the config as `${env:MCPOLYGLOT_BEARER_TOKEN}`,
   or use the `oauth` auth block with your IdP's issuer and audience.
3. In claude.ai: Customize > Connectors > Add > Add custom connector. Paste the `/mcp` URL.
   Bearer: add a request header `Authorization: Bearer <token>`. OAuth: pick a sign-in mode.
4. Free plans get one custom connector; Team/Enterprise need an Owner to add it.

## Cursor (stdio)

`.cursor/mcp.json` in the project (or `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "mcpolyglot": {
      "command": "npx",
      "args": ["-y", "@mcpolyglot/cli", "serve", "--config", "/abs/path/mcpolyglot.config.ts"],
      "env": { "DATABASE_URL": "${env:DATABASE_URL}" }
    }
  }
}
```

Cursor also reads this skill from `.agents/skills/` directly.

## Codex CLI and ChatGPT desktop (stdio)

```bash
codex mcp add mcpolyglot -- npx -y @mcpolyglot/cli serve --config /abs/path/mcpolyglot.config.ts
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.mcpolyglot]
command = "npx"
args = ["-y", "@mcpolyglot/cli", "serve", "--config", "/abs/path/mcpolyglot.config.ts"]
env = { DATABASE_URL = "postgres://..." }
```

Codex reads this skill from `.agents/skills/`. `agents/openai.yaml` next to `SKILL.md` declares
the MCP dependency so Codex can prompt to connect it; edit its `url` if you run HTTP elsewhere.

## ChatGPT web (Streamable HTTP)

ChatGPT reaches MCP only through custom connectors (Settings > Connectors, Developer Mode) or a
plugin that bundles a remote MCP connection. Same requirement as claude.ai: public HTTPS URL,
bearer header or OAuth. Plan eligibility changes often; check OpenAI's help center.

## Gemini CLI (stdio)

```bash
gemini mcp add mcpolyglot npx -y @mcpolyglot/cli serve --config /abs/path/mcpolyglot.config.ts
```

or `mcpServers` in `.gemini/settings.json` / `~/.gemini/settings.json` with the same
`command` / `args` / `env` shape as Cursor. Gemini CLI reads this skill from `.agents/skills/`.

## Any other MCP client

stdio: `npx -y @mcpolyglot/cli serve --config <abs path>`.
HTTP: `POST https://host/mcp` with `Authorization: Bearer <token>`,
`Accept: application/json, text/event-stream`. `GET /healthz` is unauthenticated.
