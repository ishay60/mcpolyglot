# @mcpolyglot/client

Typed client for a running [mcpolyglot](https://github.com/ishay60/mcpolyglot) HTTP server. Use it from scripts, backends, or tests that want policy-checked database access without an MCP host. Every call goes through the same server pipeline an agent's would: scopes, policy, redaction, rate limit, audit.

```bash
npm i @mcpolyglot/client
```

```ts
import { McpolyglotClient, McpolyglotDeniedError } from '@mcpolyglot/client';

const db = await McpolyglotClient.connect('http://127.0.0.1:7337/mcp', {
  token: process.env.MCPOLYGLOT_TOKEN!,
  agentId: 'billing-report', // shows up as agentId in the audit log
});

const tables = await db.listTables('bank'); // only what the policy exposes

const { rows } = await db.query<{ kind: string; balance_cents: string }>(
  'bank',
  'SELECT kind, balance_cents FROM accounts WHERE customer_id = $1',
  [1],
);

const { decision } = await db.query('bank', 'DELETE FROM accounts WHERE id = 1', [], {
  dryRun: true,
}); // { allow: false, reason: 'Table "accounts" is read-only ...', ... }

try {
  await db.query('bank', 'SELECT ssn FROM customers');
} catch (e) {
  if (e instanceof McpolyglotDeniedError) console.log(e.code, e.reason); // forbidden.policy ...
}

await db.close();
```

## API

- `McpolyglotClient.connect(url, { token, agentId? })`: `url` is the server's `/mcp` endpoint.
- `listTables(sourceId)`: `TableInfo[]`, with hidden tables and denied columns already removed.
- `query<Row>(sourceId, sql, params?, { limit?, dryRun? })`: `QueryResult<Row>`, or `DryRunResult` when `dryRun: true`. `Row` is a type assertion, not a runtime check.
- `McpolyglotDeniedError`: thrown when the server refuses a call. `code` is `forbidden.policy`, `forbidden.scope`, `rate_limited`, or `timeout`; `reason` is the server's explanation.

Values arrive as the server serializes them. On Postgres, `bigint` and `numeric` come back as strings.

MIT licensed.
