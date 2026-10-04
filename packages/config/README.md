# @mcpolyglot/config

Config schema and loader for [mcpolyglot](https://github.com/ishay60/mcpolyglot). Validates user config with Zod and resolves secrets from env / file / OS keychain refs.

## Define a config

```ts
import { defineConfig } from '@mcpolyglot/config';

export default defineConfig({
  server: { name: 'mcpolyglot', version: '0.0.1' },
  transport: { kind: 'stdio' },
  sources: [
    {
      id: 'pg.main',
      kind: 'postgres',
      url: '${env:DATABASE_URL}',
      scopes: ['schema:read', 'tables:read', 'query:raw'],
      limits: { rowCap: 200, timeoutMs: 10_000, maxBytes: 262144 },
      redact: { columns: ['public.users.password_hash'], patterns: [] },
    },
  ],
});
```

Both `.ts` and `.yaml` configs are supported.

## Secret refs

Literal credentials are rejected. You must use one of:

- `${env:NAME}` — process environment.
- `${file:./path}` — file on disk (good for Docker secrets / mounted files).
- `${keychain:item}` — OS keychain via the optional `keytar` dep.

## Docs

- Full README → https://github.com/ishay60/mcpolyglot
- Schema source → [`src/schema.ts`](./src/schema.ts)

MIT licensed.
