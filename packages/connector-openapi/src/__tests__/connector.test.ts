import { describe, expect, it } from 'vitest';
import type { ConnectorInitCtx, ToolExecCtx } from '@mcpolyglot/core';
import { OpenApiConnector, type OpenApiConnectorOptions } from '../connector.js';

const spec = {
  openapi: '3.0.0',
  paths: {
    '/users/{id}': {
      parameters: [{ $ref: '#/components/parameters/Id' }],
      get: {
        operationId: 'getUser',
        parameters: [{ name: 'fields', in: 'query', schema: { type: 'string' } }],
      },
      delete: { operationId: 'deleteUser' },
    },
    '/users': {
      post: {
        operationId: 'createUser',
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
      },
    },
  },
  components: {
    parameters: { Id: { name: 'id', in: 'path', required: true, schema: { type: 'integer' } } },
  },
};

const ctx = {
  limits: { rowCap: 10, timeoutMs: 1_000, maxBytes: 64 },
  signal: new AbortController().signal,
} as unknown as ToolExecCtx;
const noop = () => {};
const initCtx: ConnectorInitCtx = { logger: { debug: noop, info: noop, warn: noop, error: noop } };

async function setup(opts: Partial<OpenApiConnectorOptions> = {}, response?: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = (async (url: URL | string, init: RequestInit = {}) => {
    if (String(url) === 'https://spec.test/openapi.json') return new Response(JSON.stringify(spec));
    calls.push({ url: String(url), init });
    return (
      response?.() ??
      new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
    );
  }) as typeof fetch;
  const c = new OpenApiConnector({
    id: 'api',
    spec: 'https://spec.test/openapi.json',
    baseUrl: 'https://api.test/v1/',
    fetch: fakeFetch,
    ...opts,
  });
  await c.init(initCtx);
  const call = c.listPrimitiveTools().find((t) => t.name === 'api.call')!;
  return {
    c,
    calls,
    call: (args: Record<string, unknown>) => call.handler(call.inputSchema.parse(args), ctx),
  };
}

describe('openapi connector', () => {
  it('exposes only operations whose method is allowed', async () => {
    const { c, call, calls } = await setup();
    const list = c.listPrimitiveTools().find((t) => t.name === 'api.list_operations')!;
    const listed = (await list.handler({}, ctx)).content[0]!.data as { operationId: string }[];
    expect(listed.map((o) => o.operationId)).toEqual(['getUser']);
    await expect(call({ operationId: 'deleteUser', path: { id: 1 } })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(call({ operationId: 'createUser', body: {} })).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(calls).toHaveLength(0);
  });

  it('calls under baseUrl with config auth, encoded params, and redirects refused', async () => {
    const { call, calls } = await setup({ auth: { type: 'bearer', token: 't0k' } });
    const res = await call({
      operationId: 'getUser',
      path: { id: 'a/b?c' },
      query: { fields: 'x' },
    });
    expect(res.content[0]!.data).toEqual({ status: 200, body: { ok: true }, truncated: false });
    expect(calls[0]!.url).toBe('https://api.test/v1/users/a%2Fb%3Fc?fields=x');
    expect(calls[0]!.init).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: { authorization: 'Bearer t0k' },
    });
  });

  it.each<[Record<string, unknown>, string]>([
    [{ path: { id: '..' } }, 'traversal'],
    [{ path: { id: '' } }, 'empty path param'],
    [{ path: {} }, 'missing path param'],
    [{ path: { id: 1, extra: 2 } }, 'unknown path param'],
    [{ path: { id: 1 }, query: { admin: true } }, 'undeclared query param'],
    [{ path: { id: 1 }, body: { a: 1 } }, 'body on an operation without one'],
  ])('rejects %j (%s) before any request', async (args) => {
    const { call, calls } = await setup();
    await expect(call({ operationId: 'getUser', ...args })).rejects.toMatchObject({
      code: 'invalid_args',
    });
    expect(calls).toHaveLength(0);
  });

  it('sends a JSON body when the method is allowed, and is then not read-only', async () => {
    const { c, call, calls } = await setup({ allowMethods: ['GET', 'POST'] });
    await call({ operationId: 'createUser', body: { name: 'a' } });
    expect(calls[0]!.init).toMatchObject({ method: 'POST', body: '{"name":"a"}' });
    expect(c.listPrimitiveTools().find((t) => t.name === 'api.call')!.readOnly).toBe(false);
  });

  it('caps the response at maxBytes and flags upstream errors', async () => {
    const { call } = await setup({}, () => new Response('x'.repeat(1000), { status: 500 }));
    const res = await call({ operationId: 'getUser', path: { id: 1 } });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.data).toEqual({ status: 500, body: 'x'.repeat(64), truncated: true });
  });
});
