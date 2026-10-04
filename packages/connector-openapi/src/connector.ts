import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';
import type {
  Connector,
  ConnectorInitCtx,
  OperationSchema,
  PerEntityConfig,
  SchemaSnapshot,
  ToolDefinition,
} from '@mcpolyglot/core';
import { McpolyglotError } from '@mcpolyglot/core';

const METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof METHODS)[number];
const SAFE_METHODS: readonly HttpMethod[] = ['GET', 'HEAD', 'OPTIONS'];

export type OpenApiAuth =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'apiKey'; header: string; value: string }
  | { type: 'basic'; username: string; password: string };

export interface OpenApiConnectorOptions {
  id: string;
  /** Path or http(s) URL of an OpenAPI 3 document, JSON or YAML. */
  spec: string;
  /** Every call goes here. The spec's own `servers` are ignored. */
  baseUrl: string;
  auth?: OpenApiAuth;
  /** Operations with any other method are not exposed. Defaults to GET / HEAD / OPTIONS. */
  allowMethods?: readonly HttpMethod[];
  /** For tests. */
  fetch?: typeof fetch;
}

type Operation = OperationSchema & { bodySchema?: unknown };
type Json = Record<string, unknown>;

const Scalar = z.union([z.string(), z.number(), z.boolean()]);

export class OpenApiConnector implements Connector {
  readonly id: string;
  readonly kind = 'openapi' as const;
  private readonly spec: string;
  private readonly base: URL;
  private readonly auth: OpenApiAuth;
  private readonly allowMethods: readonly HttpMethod[];
  private readonly fetch: typeof fetch;
  private ops?: Map<string, Operation>;

  constructor(opts: OpenApiConnectorOptions) {
    this.id = opts.id;
    this.spec = opts.spec;
    this.base = new URL(opts.baseUrl.replace(/\/+$/, ''));
    this.auth = opts.auth ?? { type: 'none' };
    this.allowMethods = opts.allowMethods ?? SAFE_METHODS;
    this.fetch = opts.fetch ?? fetch;
  }

  async init(ctx: ConnectorInitCtx): Promise<void> {
    const text = /^https?:\/\//i.test(this.spec)
      ? await (await this.fetch(this.spec, { redirect: 'error' })).text()
      : await readFile(this.spec, 'utf8');
    // YAML is a superset of JSON, so one parser covers both.
    this.ops = collectOperations(parse(text) as Json, this.allowMethods);
    ctx.logger.info('connector.openapi.loaded', { id: this.id, operations: this.ops.size });
  }

  async close(): Promise<void> {
    this.ops = undefined;
  }

  // ponytail: reports the spec as loaded, doesn't ping the API — no endpoint is known to be
  // safe to call. Add a configurable `healthPath` if doctor needs a live check.
  async health(): Promise<{ ok: boolean; latencyMs: number; details?: string }> {
    return this.ops
      ? { ok: true, latencyMs: 0, details: `${this.ops.size} operations` }
      : { ok: false, latencyMs: 0, details: 'spec not loaded' };
  }

  async introspect(): Promise<SchemaSnapshot> {
    return {
      kind: 'openapi',
      operations: [...this.requireOps().values()].map(({ bodySchema: _b, ...op }) => op),
    };
  }

  listPrimitiveTools(): ToolDefinition[] {
    const id = this.id;
    return [
      {
        name: `${id}.list_operations`,
        description: `List the ${id} API operations that can be called.`,
        inputSchema: z.object({}).strict(),
        scopes: ['http:call'],
        readOnly: true,
        handler: async () => {
          const ops = [...this.requireOps().values()].map((o) => ({
            operationId: o.operationId,
            method: o.method,
            path: o.path,
            ...(o.summary ? { summary: o.summary } : {}),
          }));
          return { content: [{ type: 'json', data: ops }], metadata: { rows: ops.length } };
        },
      },
      {
        name: `${id}.describe_operation`,
        description: `Describe one operation: its parameters and request body schema.`,
        inputSchema: z.object({ operationId: z.string().min(1) }).strict(),
        scopes: ['http:call'],
        readOnly: true,
        handler: async ({ operationId }) => ({
          content: [{ type: 'json', data: this.requireOp(operationId) }],
        }),
      },
      {
        name: `${id}.call`,
        description: `Call one operation of the ${id} API by operationId. Only parameters the spec declares are accepted.`,
        inputSchema: z
          .object({
            operationId: z.string().min(1),
            path: z.record(z.string(), Scalar).default({}).describe('Path parameters'),
            query: z
              .record(z.string(), z.union([Scalar, z.array(Scalar)]))
              .default({})
              .describe('Query parameters'),
            body: z.unknown().optional().describe('JSON request body'),
          })
          .strict(),
        scopes: ['http:call'],
        readOnly: this.allowMethods.every((m) => SAFE_METHODS.includes(m)),
        handler: async ({ operationId, path, query, body }, ctx) => {
          const op = this.requireOp(operationId);
          if (body !== undefined && !op.requestBody) {
            throw new McpolyglotError(
              'invalid_args',
              `Operation "${operationId}" takes no request body`,
            );
          }
          const headers: Record<string, string> = {
            accept: 'application/json',
            ...this.authHeader(),
          };
          if (body !== undefined) headers['content-type'] = 'application/json';
          const res = await this.fetch(this.buildUrl(op, path, query), {
            method: op.method,
            headers,
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            // A redirect could carry the credentials to another host.
            redirect: 'error',
            signal: ctx.signal,
          });
          const { text, truncated } = await readCapped(res, ctx.limits.maxBytes);
          const isJson = /json/i.test(res.headers.get('content-type') ?? '');
          return {
            content: [
              {
                type: 'json',
                data: {
                  status: res.status,
                  body: isJson && !truncated && text ? JSON.parse(text) : text,
                  truncated,
                },
              },
            ],
            isError: !res.ok,
            metadata: { truncated },
          };
        },
      },
    ];
  }

  generatePerEntityTools(_cfg: PerEntityConfig): ToolDefinition[] {
    return [];
  }

  private buildUrl(op: Operation, path: Json, query: Json): URL {
    const invalid = (msg: string) => new McpolyglotError('invalid_args', msg);
    const used = new Set<string>();
    const pathname = op.path.replace(/\{([^}]+)\}/g, (_m, name: string) => {
      const v = path[name];
      if (v === undefined) throw invalid(`Missing path parameter "${name}"`);
      const s = String(v);
      // encodeURIComponent leaves dots alone, and a `..` segment would climb out of the path.
      if (s === '' || s === '.' || s === '..') throw invalid(`Invalid path parameter "${name}"`);
      used.add(name);
      return encodeURIComponent(s);
    });
    for (const k of Object.keys(path)) {
      if (!used.has(k)) throw invalid(`Unknown path parameter "${k}"`);
    }
    const url = new URL(this.base.href.replace(/\/+$/, '') + pathname);
    const declared = new Set(op.parameters.filter((p) => p.in === 'query').map((p) => p.name));
    for (const [k, v] of Object.entries(query)) {
      if (!declared.has(k)) throw invalid(`Unknown query parameter "${k}"`);
      for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(item));
    }
    // Host pinning: whatever the spec or the arguments say, the request stays under baseUrl.
    if (url.origin !== this.base.origin || !url.pathname.startsWith(this.base.pathname)) {
      throw new McpolyglotError('forbidden.policy', `Request leaves ${this.base.href}`);
    }
    return url;
  }

  private authHeader(): Record<string, string> {
    const a = this.auth;
    switch (a.type) {
      case 'bearer':
        return { authorization: `Bearer ${a.token}` };
      case 'apiKey':
        return { [a.header]: a.value };
      case 'basic':
        return {
          authorization: `Basic ${Buffer.from(`${a.username}:${a.password}`).toString('base64')}`,
        };
      default:
        return {};
    }
  }

  private requireOp(operationId: string): Operation {
    const op = this.requireOps().get(operationId);
    if (!op) {
      throw new McpolyglotError(
        'not_found',
        `Operation "${operationId}" is not in the ${this.id} spec or its method is not allowed`,
      );
    }
    return op;
  }

  private requireOps(): Map<string, Operation> {
    if (!this.ops) {
      throw new McpolyglotError('connector.not_initialized', 'OpenApiConnector spec not loaded');
    }
    return this.ops;
  }
}

/** Operations of the spec whose method is allowed, keyed by operationId. */
function collectOperations(doc: Json, allow: readonly HttpMethod[]): Map<string, Operation> {
  // ponytail: resolves local `#/...` refs one level deep. Nested refs inside a body schema are
  // returned as-is; pull in a dereferencer if models need them expanded.
  const deref = (v: unknown): Json | undefined => {
    const ref = (v as Json | undefined)?.['$ref'];
    if (typeof ref !== 'string') return v as Json | undefined;
    if (!ref.startsWith('#/')) return undefined;
    return ref
      .slice(2)
      .split('/')
      .reduce<unknown>(
        (o, k) => (o as Json | undefined)?.[k.replace(/~1/g, '/').replace(/~0/g, '~')],
        doc,
      ) as Json | undefined;
  };

  const ops = new Map<string, Operation>();
  for (const [path, rawItem] of Object.entries((doc['paths'] as Json | undefined) ?? {})) {
    const item = deref(rawItem) ?? {};
    for (const method of METHODS) {
      const raw = item[method.toLowerCase()] as Json | undefined;
      if (!raw || !allow.includes(method)) continue;
      const params = [item['parameters'], raw['parameters']]
        .flatMap((p) => (Array.isArray(p) ? p : []))
        .map(deref)
        // ponytail: header and cookie parameters are not settable by the model; only config
        // auth sets headers. Add an allow-list if an API needs e.g. a version header.
        .filter((p): p is Json => p?.['in'] === 'query' || p?.['in'] === 'path');
      const body = deref(raw['requestBody']);
      const content = (body?.['content'] as Json | undefined) ?? {};
      const contentType =
        'application/json' in content ? 'application/json' : Object.keys(content)[0];
      const schema = contentType
        ? (content[contentType] as Json | undefined)?.['schema']
        : undefined;
      const schemaRef = (schema as Json | undefined)?.['$ref'];
      const operationId = String(raw['operationId'] ?? `${method} ${path}`);
      ops.set(operationId, {
        operationId,
        method,
        path,
        ...(typeof raw['summary'] === 'string' ? { summary: raw['summary'] } : {}),
        // Later (operation-level) entries override path-level ones with the same name.
        parameters: [
          ...new Map(
            params.map((p) => [
              `${String(p['in'])}:${String(p['name'])}`,
              {
                name: String(p['name']),
                in: p['in'] as 'query' | 'path',
                required: p['required'] === true,
                type: String((p['schema'] as Json | undefined)?.['type'] ?? 'string'),
              },
            ]),
          ).values(),
        ],
        ...(contentType
          ? {
              requestBody: {
                contentType,
                ...(typeof schemaRef === 'string' ? { schemaRef } : {}),
              },
              bodySchema: deref(schema),
            }
          : {}),
      });
    }
  }
  return ops;
}

/** Reads at most `maxBytes` of the body, so a huge response never sits in memory. */
async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { text: Buffer.concat(chunks).toString('utf8'), truncated: false };
    chunks.push(value);
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return {
        text: Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8'),
        truncated: true,
      };
    }
  }
}
