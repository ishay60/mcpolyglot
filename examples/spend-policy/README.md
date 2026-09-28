# spend-policy

An agent that can record spending on a generic fintech schema, within limits it can't talk its way past. Three layers do the work:

1. **Policy.** `transactions` is the only writable table. `accounts` and `customers` are read-only, and `customers.ssn` is denied. `maxWritesPerCall: 1` means one row per call.
2. **The database.** A `CHECK (amount_cents >= -50000)` constraint rejects any single debit over $500, whatever SQL the agent writes.
3. **Idempotency.** A retry with the same `idempotencyKey` returns the first result instead of posting twice.

```bash
sqlite3 bank.db < seed.sql
npx @mcpolyglot/cli serve --config ./mcpolyglot.config.json
```

| Agent sends                                                                                            | Result                                                         |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `bank.execute` `INSERT INTO transactions (account_id, amount_cents, memo) VALUES (1, -2500, 'Coffee')` | `rowsAffected: 1`                                              |
| same call again with `idempotencyKey: "coffee-1"` twice                                                | one row written, the second call replays the first result      |
| `bank.execute` `INSERT … VALUES (1, -90000, 'TV')`                                                     | rejected by the database's `CHECK` constraint; nothing written |
| `bank.execute` `UPDATE accounts SET balance_cents = 999999 WHERE id = 1`                               | `forbidden.policy`: `accounts` is read-only                    |
| `bank.execute` `DELETE FROM transactions WHERE account_id = 1` (2+ rows)                               | rolled back: exceeds `maxWritesPerCall`                        |
| `bank.query` `SELECT ssn FROM customers`                                                               | `forbidden.policy`: denied column                              |
| `bank.execute` `DROP TABLE transactions`                                                               | `forbidden.policy`: always blocked                             |

The balance isn't recomputed from `transactions`. That's application logic, and it belongs in your database (a trigger or a view), not in the agent.

Every row in this table is exercised by `packages/cli/src/__tests__/examples.test.ts`.
