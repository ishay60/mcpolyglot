# @mcpolyglot/core

The runtime that powers [mcpolyglot](https://github.com/ishay60/mcpolyglot). Defines the `Connector` interface, the `McpolyglotServer`, the transport abstraction, and the non-bypassable security pipeline that wraps every tool call.

You usually don't depend on this directly — install [`@mcpolyglot/cli`](https://www.npmjs.com/package/@mcpolyglot/cli) instead. Use this package when you want to embed mcpolyglot in your own host or write a custom connector.

## What's in here

- **`McpolyglotServer`** — wires connectors, security hooks, and a transport into an MCP-compliant server. Every tool call goes through the same pipeline:
  ```
  scope check → rate limit → timeout → handler → redact → size cap → wrap → audit
  ```
  Connectors can't opt out.
- **`Connector`** — the interface a data-source adapter implements (`init`, `close`, `health`, `listPrimitiveTools`, optional `diagnose`).
- **`Transport`** — minimal contract; ships with `StdioTransport` and `StreamableHttpTransport`.
- **`ToolDefinition`** — `{ name, description, inputSchema (zod), scopes, readOnly, handler }`.

## Subpath exports

```ts
import { McpolyglotServer } from '@mcpolyglot/core';
import { StdioTransport } from '@mcpolyglot/core/transports/stdio';
import { StreamableHttpTransport } from '@mcpolyglot/core/transports/streamable-http';
```

## Docs

- Architecture → https://github.com/ishay60/mcpolyglot/blob/develop/ARCHITECTURE.md
- Pipeline source → [`src/server.ts`](./src/server.ts) (`executeTool`)

MIT licensed.
