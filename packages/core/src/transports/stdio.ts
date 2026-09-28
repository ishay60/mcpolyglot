import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '../transport.js';

export class StdioTransport implements Transport {
  readonly kind = 'stdio' as const;
  private inner?: StdioServerTransport;

  async start(createServer: () => Server): Promise<void> {
    this.inner = new StdioServerTransport();
    await createServer().connect(this.inner);
  }

  async stop(): Promise<void> {
    await this.inner?.close();
    this.inner = undefined;
  }
}
