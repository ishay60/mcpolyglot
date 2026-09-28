# readonly-analytics

An agent that answers product questions from your data and can't change anything. No table is writable, so the connection itself opens read-only.

```bash
sqlite3 analytics.db < seed.sql
npx @mcpolyglot/cli doctor --config ./mcpolyglot.config.json
npx @mcpolyglot/cli serve  --config ./mcpolyglot.config.json
```

What the policy does:

| Agent sends                                                                                                                 | Result                                                     |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `SELECT plan, count(*) AS n FROM users GROUP BY plan`                                                                       | rows                                                       |
| `SELECT u.plan, count(*) AS exports FROM events e JOIN users u ON u.id = e.user_id WHERE e.name = 'export' GROUP BY u.plan` | rows                                                       |
| `SELECT password_hash FROM users`                                                                                           | `forbidden.policy`: denied column                          |
| `SELECT * FROM users`                                                                                                       | `forbidden.policy`: `*` would expose a denied column       |
| `SELECT body FROM internal_notes`                                                                                           | `forbidden.policy`: not accessible (`defaultAccess: none`) |
| `DELETE FROM events WHERE id = 1`                                                                                           | `forbidden.policy`: read-only                              |

`internal_notes` and `password_hash` also don't appear in `list_tables`. Each call writes one line to `./audit.jsonl`.

Every row in this table is exercised by `packages/cli/src/__tests__/examples.test.ts`.
