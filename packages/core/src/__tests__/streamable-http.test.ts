import { afterEach, describe, expect, it } from 'vitest';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { hashToken, matchAgent, StreamableHttpTransport } from '../transports/streamable-http.js';

// Silence the JSON banner the transport emits to stderr during tests.
const silentLogger = { info: () => {}, warn: () => {} };

async function fetchStatus(
  url: string,
  init?: { headers?: Record<string, string>; method?: string },
): Promise<{ status: number; body: string }> {
  const res = await fetch(url, init);
  const body = await res.text();
  return { status: res.status, body };
}

describe('StreamableHttpTransport', () => {
  let transport: StreamableHttpTransport | undefined;
  let mcpServer: McpServer | undefined;
  let baseUrl = '';

  afterEach(async () => {
    if (transport) await transport.stop();
    transport = undefined;
    mcpServer = undefined;
    baseUrl = '';
  });

  async function boot(opts: ConstructorParameters<typeof StreamableHttpTransport>[0]) {
    mcpServer = new McpServer(
      { name: 'mcpolyglot-test', version: '0.0.0' },
      { capabilities: { tools: {} } },
    );
    transport = new StreamableHttpTransport({
      ...opts,
      logger: silentLogger,
    });
    await transport.start(() => mcpServer!);
    // We bind on port 0 so the OS picks; recover the real port from the
    // listening socket. Field access is intentional — the public class
    // doesn't expose the address since the CLI already knows it.
    const httpServer = (transport as unknown as { httpServer: { address(): { port: number } } })
      .httpServer;
    baseUrl = `http://${opts.host}:${httpServer.address().port}`;
  }

  it('serves /healthz without auth', async () => {
    await boot({ host: '127.0.0.1', port: 0, auth: { kind: 'bearer', token: 'shh' } });
    const res = await fetchStatus(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('rejects requests without a Bearer header', async () => {
    await boot({ host: '127.0.0.1', port: 0, auth: { kind: 'bearer', token: 'shh' } });
    const res = await fetchStatus(`${baseUrl}/mcp`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body).reason).toBe('missing_bearer');
  });

  it('rejects a wrong bearer token', async () => {
    await boot({ host: '127.0.0.1', port: 0, auth: { kind: 'bearer', token: 'shh' } });
    const res = await fetchStatus(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer not-shh' },
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body).reason).toBe('invalid_token');
  });

  it('exposes the auto-generated bearer token in `bearerToken`', async () => {
    await boot({ host: '127.0.0.1', port: 0 });
    expect(transport!.authKind).toBe('bearer');
    expect(typeof transport!.bearerToken).toBe('string');
    expect(transport!.bearerToken!.length).toBeGreaterThan(16);
  });

  it('agents mode: known token passes, revoked and unknown tokens get 401', async () => {
    await boot({
      host: '127.0.0.1',
      port: 0,
      auth: {
        kind: 'agents',
        agents: [
          {
            id: 'a',
            tokens: [{ hash: hashToken('old'), revoked: true }, { hash: hashToken('new') }],
          },
        ],
      },
    });
    expect(transport!.bearerToken).toBeUndefined();
    const call = (token: string) =>
      fetchStatus(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await call('old')).status).toBe(401);
    expect((await call('nope')).status).toBe(401);
    // Past auth; the SDK then rejects the empty body, which is not a 401.
    expect((await call('new')).status).not.toBe(401);
  });
});

describe('agent token hashing', () => {
  it('hashToken is sha256 hex', () => {
    // sha256("abc"), FIPS 180-2 test vector.
    expect(hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('matchAgent finds the owner and nothing for unknown or malformed hashes', () => {
    const hashes = [
      { agentId: 'bad', hash: Buffer.from('abcd', 'hex') },
      { agentId: 'a', hash: Buffer.from(hashToken('ta'), 'hex') },
      { agentId: 'b', hash: Buffer.from(hashToken('tb'), 'hex') },
    ];
    expect(matchAgent(hashes, 'ta')).toBe('a');
    expect(matchAgent(hashes, 'tb')).toBe('b');
    expect(matchAgent(hashes, 'tc')).toBeUndefined();
    expect(matchAgent([], 'ta')).toBeUndefined();
  });
});
