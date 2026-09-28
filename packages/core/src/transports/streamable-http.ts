import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { Transport } from '../transport.js';
import { createOAuthVerifier, type OAuthVerifier, type OAuthVerifierOptions } from './oauth.js';

/** Bearer-token mode: a fixed shared secret on the `Authorization` header. */
export interface BearerAuthOptions {
  kind: 'bearer';
  /** Pre-shared bearer token. Auto-generated if omitted. */
  token?: string;
}

/** OAuth mode: signature + claim verification against a JWKS. */
export interface OAuthAuthOptions extends OAuthVerifierOptions {
  kind: 'oauth';
}

/**
 * Per-agent tokens: each bearer token is sha256-hashed and matched against the agents'
 * stored hashes. The matched agent id reaches request handlers as `authInfo.clientId`.
 */
export interface AgentsAuthOptions {
  kind: 'agents';
  agents: ReadonlyArray<{
    id: string;
    tokens: ReadonlyArray<{ hash: string; revoked?: boolean }>;
  }>;
}

export type HttpAuthOptions = BearerAuthOptions | OAuthAuthOptions | AgentsAuthOptions;

export interface StreamableHttpTransportOptions {
  host: string;
  port: number;
  /**
   * Auth strategy. Defaults to `{ kind: 'bearer' }` (auto-generated token)
   * for back-compat with the original API.
   */
  auth?: HttpAuthOptions;
  /**
   * @deprecated Pass `auth: { kind: 'bearer', token }` instead. Retained so
   * existing callers (and the CLI's `--http` flag without OAuth config)
   * keep working unchanged.
   */
  bearerToken?: string;
  /** Where to log server startup banner / auth-failure events. Stderr by default. */
  logger?: {
    info: (msg: string, fields?: Record<string, unknown>) => void;
    warn: (msg: string, fields?: Record<string, unknown>) => void;
  };
}

type ResolvedAuth =
  | { kind: 'bearer'; token: string }
  | { kind: 'agents'; hashes: { agentId: string; hash: Buffer }[] }
  | { kind: 'oauth'; verifier: OAuthVerifier; issuer: string; audience: string };

export class StreamableHttpTransport implements Transport {
  readonly kind = 'http' as const;
  /** Bearer token in use, or `undefined` when running in OAuth mode. */
  readonly bearerToken: string | undefined;
  readonly authKind: 'bearer' | 'oauth' | 'agents';
  private readonly host: string;
  private readonly port: number;
  private readonly auth: ResolvedAuth;
  private readonly logger: NonNullable<StreamableHttpTransportOptions['logger']>;
  private newServer?: () => McpServer;
  private httpServer?: HttpServer;

  constructor(opts: StreamableHttpTransportOptions) {
    this.host = opts.host;
    this.port = opts.port;
    this.auth = resolveAuth(opts);
    this.authKind = this.auth.kind;
    this.bearerToken = this.auth.kind === 'bearer' ? this.auth.token : undefined;
    this.logger = opts.logger ?? {
      info: (msg, fields) =>
        process.stderr.write(JSON.stringify({ level: 'info', msg, ...(fields ?? {}) }) + '\n'),
      warn: (msg, fields) =>
        process.stderr.write(JSON.stringify({ level: 'warn', msg, ...(fields ?? {}) }) + '\n'),
    };
  }

  async start(newServer: () => McpServer): Promise<void> {
    this.newServer = newServer;

    this.httpServer = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.logger.warn('http.handler.error', {
          error: (err as Error).message,
          stack: (err as Error).stack,
        });
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end();
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once('error', reject);
      this.httpServer!.listen(this.port, this.host, () => {
        this.httpServer!.off('error', reject);
        resolve();
      });
    });

    const fields: Record<string, unknown> = {
      host: this.host,
      port: this.port,
      auth: this.auth.kind,
    };
    if (this.auth.kind === 'bearer') {
      // Tokens are sensitive; emit a fingerprint not the token itself.
      fields.tokenFingerprint = fingerprint(this.auth.token);
    } else if (this.auth.kind === 'agents') {
      fields.agents = new Set(this.auth.hashes.map((h) => h.agentId)).size;
    } else {
      fields.issuer = this.auth.issuer;
      fields.audience = this.auth.audience;
    }
    this.logger.info('http.listening', fields);

    if (!isLoopback(this.host)) {
      this.logger.warn('http.bound_non_loopback', {
        host: this.host,
        recommendation: 'put behind a reverse proxy with TLS',
      });
    }
  }

  async stop(): Promise<void> {
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = undefined;
    }
    this.newServer = undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    const authResult = await this.checkAuth(req);
    if (!authResult.ok) {
      res.statusCode = 401;
      res.setHeader('WWW-Authenticate', wwwAuthenticate(this.auth.kind, authResult.reason));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'unauthorized', reason: authResult.reason }));
      return;
    }

    if (!this.newServer) {
      res.statusCode = 503;
      res.end();
      return;
    }
    if (authResult.agentId) {
      // The SDK hands `req.auth` to request handlers as `extra.authInfo`. No token in it.
      const auth: AuthInfo = { token: '', clientId: authResult.agentId, scopes: [] };
      (req as IncomingMessage & { auth?: AuthInfo }).auth = auth;
    }
    // Stateless mode: the SDK allows one request per transport, so each request gets its own
    // transport + protocol server, torn down when the response closes.
    const inner = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    inner.onerror = (err) => {
      this.logger.warn('http.transport.error', { error: err.message });
    };
    const server = this.newServer();
    res.on('close', () => {
      void inner.close();
      void server.close();
    });
    await server.connect(inner);
    await inner.handleRequest(req, res);
  }

  private async checkAuth(
    req: IncomingMessage,
  ): Promise<{ ok: true; agentId?: string } | { ok: false; reason: string }> {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) {
      return { ok: false, reason: 'missing_bearer' };
    }
    const token = header.slice('Bearer '.length);

    if (this.auth.kind === 'bearer') {
      const expected = this.auth.token;
      const a = Buffer.from(token);
      const b = Buffer.from(expected);
      if (a.length !== b.length) return { ok: false, reason: 'invalid_token' };
      return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'invalid_token' };
    }

    if (this.auth.kind === 'agents') {
      const agentId = matchAgent(this.auth.hashes, token);
      return agentId ? { ok: true, agentId } : { ok: false, reason: 'invalid_token' };
    }

    const result = await this.auth.verifier.verify(token);
    if (!result.ok) {
      this.logger.warn('http.oauth.rejected', { reason: result.reason });
      return { ok: false, reason: result.reason };
    }
    return { ok: true };
  }
}

function resolveAuth(opts: StreamableHttpTransportOptions): ResolvedAuth {
  // Back-compat: legacy `bearerToken` arg wins if no `auth` was supplied.
  if (!opts.auth) {
    return { kind: 'bearer', token: opts.bearerToken ?? generateToken() };
  }
  if (opts.auth.kind === 'agents') {
    return {
      kind: 'agents',
      // Revoked tokens are dropped here, so they fail exactly like unknown ones.
      hashes: opts.auth.agents.flatMap((a) =>
        a.tokens
          .filter((t) => !t.revoked)
          .map((t) => ({ agentId: a.id, hash: Buffer.from(t.hash.toLowerCase(), 'hex') })),
      ),
    };
  }
  if (opts.auth.kind === 'bearer') {
    return { kind: 'bearer', token: opts.auth.token ?? opts.bearerToken ?? generateToken() };
  }
  return {
    kind: 'oauth',
    verifier: createOAuthVerifier(opts.auth),
    issuer: opts.auth.issuer,
    audience: opts.auth.audience,
  };
}

function wwwAuthenticate(kind: ResolvedAuth['kind'], reason: string): string {
  const errorCode = mapReasonToWwwError(reason);
  // RFC 6750 §3 — `error` and `error_description` belong on Bearer challenges.
  if (kind !== 'oauth') {
    return `Bearer realm="mcpolyglot", error="${errorCode}"`;
  }
  return `Bearer realm="mcpolyglot", error="${errorCode}", error_description="${reason}"`;
}

function mapReasonToWwwError(reason: string): string {
  switch (reason) {
    case 'missing_bearer':
      return 'invalid_request';
    case 'token_expired':
    case 'invalid_token':
    case 'signature_invalid':
    case 'unknown_key':
    case 'claim_validation_failed':
      return 'invalid_token';
    default:
      return 'invalid_token';
  }
}

/** sha256 hex of a bearer token — the only form an agent token is ever stored in. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Compare the token's hash against every stored hash with `timingSafeEqual`, without
 * stopping at the first match, so timing doesn't reveal which (or whether an) entry hit.
 */
export function matchAgent(
  hashes: readonly { agentId: string; hash: Buffer }[],
  token: string,
): string | undefined {
  const candidate = createHash('sha256').update(token).digest();
  let found: string | undefined;
  for (const h of hashes) {
    if (h.hash.length === candidate.length && timingSafeEqual(h.hash, candidate)) {
      found ??= h.agentId;
    }
  }
  return found;
}

function generateToken(): string {
  return randomBytes(24).toString('base64url');
}

function fingerprint(token: string): string {
  // first 4 + last 4 — enough to recognize, not enough to recover
  return token.slice(0, 4) + '…' + token.slice(-4);
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}
