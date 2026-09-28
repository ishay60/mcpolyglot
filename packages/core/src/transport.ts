import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

/**
 * Carries an `McpolyglotServer`'s JSON-RPC traffic. Two implementations ship today —
 * `StdioTransport` (Claude Desktop / Cursor / Claude Code) and
 * `StreamableHttpTransport` (long-lived HTTP service with bearer auth).
 */
export interface Transport {
  readonly kind: 'stdio' | 'http';
  /**
   * Start accepting traffic. `createServer` returns a fresh MCP server wired to the tool
   * pipeline; call it once per connection (stdio: once; stateless HTTP: per request).
   */
  start(createServer: () => Server): Promise<void>;
  /** Stop accepting traffic and close any underlying sockets. Must be idempotent. */
  stop(): Promise<void>;
}
