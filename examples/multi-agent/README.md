# multi-agent

One server, one database, three agents with different jobs. Each agent authenticates with its own token and sees only what its policy allows.

> The tokens below (`demo-support-token`, `demo-finance-token`) are public demo values; their hashes are in the config. Replace them before using this anywhere real: `npx @mcpolyglot/cli token create support-bot`.

```bash
sqlite3 app.db < seed.sql
npx @mcpolyglot/cli doctor --config ./mcpolyglot.config.json   # lists what each agent can and can't use
npx @mcpolyglot/cli serve  --config ./mcpolyglot.config.json
```

| Agent (token)                        | Can                                         | Can't                                                                                                                |
| ------------------------------------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `support-bot` (`demo-support-token`) | read `customers`, read and update `tickets` | see `invoices` (hidden from `list_tables` too)                                                                       |
| `finance-bot` (`demo-finance-token`) | read `customers` and `invoices`             | read `customers.email`; see `tickets`; use `app.execute` (no `tables:write` scope, so the tool doesn't exist for it) |
| `retired-bot` (`demo-retired-token`) | nothing                                     | its token is revoked → `401`                                                                                         |

A per-agent policy can only narrow the source policy. If `finance-bot`'s policy said `"customers": "write"`, it still couldn't write, because the source only grants `read` on `customers`. It works the other way too: a table the agent's policy doesn't list falls to that policy's `defaultAccess`, which is at most `read`. So `support-bot` restates `"tickets": "write"`; without it, its write access would be dropped. The audit log records the agent from the token, not from any header the client sends.

```bash
curl -s http://127.0.0.1:7337/mcp \
  -H 'authorization: Bearer demo-finance-token' \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"app.query","arguments":{"sql":"SELECT id, status FROM invoices"}}}'
```

Every row in the table above is exercised by `packages/cli/src/__tests__/examples.test.ts`.
