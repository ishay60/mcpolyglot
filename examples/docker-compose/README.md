# Docker Compose example

Postgres with a small fictional fintech schema (`customers`, `accounts`, `transactions`) plus mcpolyglot serving it over Streamable HTTP.

```bash
cd examples/docker-compose
MCPOLYGLOT_TOKEN=$(openssl rand -hex 24) docker compose up -d --build
curl http://127.0.0.1:7337/healthz          # {"ok":true}
```

The MCP endpoint is `http://127.0.0.1:7337/mcp` with `Authorization: Bearer $MCPOLYGLOT_TOKEN`. Without `MCPOLYGLOT_TOKEN` the compose file falls back to a dev-only token, so set it for anything beyond a local try-out.

Check what the agent can see:

```bash
docker compose exec mcpolyglot node /app/dist/bin.js doctor -c /config/mcpolyglot.config.json
```

```text
   OK   bank  sql · 0 ms
  • readable  public.accounts, public.customers, public.transactions
  • writable  none
  • hidden  none
  • hidden columns  public.customers.ssn
```

Tear down (drops the database volume):

```bash
docker compose down -v
```

## What's in here

| File                     | Purpose                                                                  |
| ------------------------ | ------------------------------------------------------------------------ |
| `seed.sql`               | Schema + sample rows, and an `agent_ro` login with `SELECT` only.        |
| `mcpolyglot.config.json` | HTTP transport, bearer token from env, read-only policy, `ssn` denied.   |
| `docker-compose.yml`     | Builds the repo-root `Dockerfile`; publishes port 7337 on loopback only. |

Two walls stand between the agent and a write: the policy (every table `read`, `defaultAccess: 'none'`) and the database role (`agent_ro` has no `INSERT`/`UPDATE`/`DELETE`).

## Using your own database

Build the image from the repo root and mount your own config:

```bash
docker build -t mcpolyglot .
docker run --rm -p 127.0.0.1:7337:7337 \
  -v "$PWD/mcpolyglot.config.json:/config/mcpolyglot.config.json:ro" \
  -e DATABASE_URL -e MCPOLYGLOT_TOKEN mcpolyglot
```

This example uses JSON; a `.ts` config works too as long as it only has a type-only import (`import type`), which is what `init` generates. The server binds `0.0.0.0` inside the container; put TLS in front of it before exposing it beyond localhost.
