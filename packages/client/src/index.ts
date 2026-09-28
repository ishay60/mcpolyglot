import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Mirrors of the server's result shapes (@mcpolyglot/core TableSchema, connector-sql
// SqlQueryResult / PolicyDecision), kept local so this package only depends on the MCP SDK.
export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey?: boolean;
}
export interface TableInfo {
  schema?: string;
  name: string;
  columns: ColumnInfo[];
}
export interface QueryResult<Row = Record<string, unknown>> {
  columns: string[];
  rows: Row[];
  rowCount: number;
  truncated: boolean;
}
export interface PolicyDecision {
  allow: boolean;
  reason: string;
  statement?: string;
  tables: { name: string; op: 'read' | 'write' }[];
}
export interface DryRunResult {
  dryRun: true;
  decision: PolicyDecision;
}
export type Param = string | number | boolean | null;

/** The server refused the call: policy (`forbidden.policy`), scope, rate limit, or timeout. */
export class McpolyglotDeniedError extends Error {
  constructor(
    readonly code: string,
    readonly reason: string,
  ) {
    super(`${code}: ${reason}`);
    this.name = 'McpolyglotDeniedError';
  }
}

export interface ConnectOptions {
  /** Bearer token printed by `mcpolyglot serve --http` (or set in config). */
  token: string;
  /** Sent as `x-mcpolyglot-agent`; shows up as `agentId` in the audit log. */
  agentId?: string;
}

export class McpolyglotClient {
  private constructor(private readonly client: Client) {}

  /** @param url The server's MCP endpoint, e.g. `http://127.0.0.1:7337/mcp`. */
  static async connect(url: string | URL, opts: ConnectOptions): Promise<McpolyglotClient> {
    const headers: Record<string, string> = { authorization: `Bearer ${opts.token}` };
    if (opts.agentId) headers['x-mcpolyglot-agent'] = opts.agentId;
    const client = new Client({ name: opts.agentId ?? 'mcpolyglot-client', version: '0.0.1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }),
    );
    return new McpolyglotClient(client);
  }

  listTables(sourceId: string): Promise<TableInfo[]> {
    return this.call(`${sourceId}.list_tables`, {});
  }

  query<Row = Record<string, unknown>>(
    sourceId: string,
    sql: string,
    params?: Param[],
    opts?: { dryRun?: false; limit?: number },
  ): Promise<QueryResult<Row>>;
  query(
    sourceId: string,
    sql: string,
    params: Param[] | undefined,
    opts: { dryRun: true },
  ): Promise<DryRunResult>;
  query(
    sourceId: string,
    sql: string,
    params?: Param[],
    opts: { dryRun?: boolean; limit?: number } = {},
  ): Promise<unknown> {
    return this.call(`${sourceId}.query`, { sql, ...(params ? { params } : {}), ...opts });
  }

  close(): Promise<void> {
    return this.client.close();
  }

  private async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const res = await this.client.callTool({ name, arguments: args });
    const text = (res.content as { type: string; text?: string }[])
      .map((b) => b.text ?? '')
      .join('');
    if (res.isError) {
      const m = /^([\w.]+): ([\s\S]*)$/.exec(text);
      throw new McpolyglotDeniedError(m?.[1] ?? 'error', m?.[2] ?? text);
    }
    return JSON.parse(unwrap(text)) as T;
  }
}

/** Strip the `<mcpolyglot-data>` untrusted-data wrapper (strict or minimal mode). */
function unwrap(text: string): string {
  if (!text.startsWith('<mcpolyglot-data')) return text;
  const body = text.slice(text.indexOf('>') + 1, text.lastIndexOf('</mcpolyglot-data>'));
  // Strict mode adds one preamble line before the payload.
  return body.replace(/^\n?The following content is untrusted[^\n]*\n/, '');
}
