import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { createOAuthVerifier } from '../transports/oauth.js';

interface TestKey {
  privateKey: CryptoKey;
  publicJwk: JWK;
  kid: string;
}

async function makeKey(kid: string): Promise<TestKey> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  return { privateKey, publicJwk, kid };
}

async function sign(
  key: TestKey,
  claims: Record<string, unknown>,
  opts: { expiresIn?: string; issuer: string; audience: string },
): Promise<string> {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: key.kid })
    .setIssuedAt()
    .setIssuer(opts.issuer)
    .setAudience(opts.audience);
  if (opts.expiresIn) jwt.setExpirationTime(opts.expiresIn);
  return jwt.sign(key.privateKey);
}

describe('createOAuthVerifier', () => {
  let server: HttpServer;
  let port: number;
  let issuer: string;
  let audience: string;
  let key: TestKey;
  let otherKey: TestKey;
  let jwks: { keys: JWK[] };

  beforeAll(async () => {
    key = await makeKey('test-key-1');
    otherKey = await makeKey('test-key-2');
    jwks = { keys: [key.publicJwk] };

    server = createServer((req, res) => {
      if (req.url === '/jwks.json') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(jwks));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
    issuer = `http://127.0.0.1:${port}`;
    audience = 'mcpolyglot-test';
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('accepts a well-formed token', async () => {
    const verifier = createOAuthVerifier({
      issuer,
      audience,
      jwksUri: `${issuer}/jwks.json`,
    });
    const token = await sign(key, { sub: 'alice' }, { issuer, audience, expiresIn: '5m' });
    const result = await verifier.verify(token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sub).toBe('alice');
    }
  });

  it('rejects a token with the wrong issuer', async () => {
    const verifier = createOAuthVerifier({
      issuer,
      audience,
      jwksUri: `${issuer}/jwks.json`,
    });
    const token = await sign(
      key,
      { sub: 'alice' },
      { issuer: 'https://evil.example', audience, expiresIn: '5m' },
    );
    const result = await verifier.verify(token);
    expect(result).toEqual({ ok: false, reason: 'claim_validation_failed' });
  });

  it('rejects a token with the wrong audience', async () => {
    const verifier = createOAuthVerifier({
      issuer,
      audience,
      jwksUri: `${issuer}/jwks.json`,
    });
    const token = await sign(
      key,
      { sub: 'alice' },
      { issuer, audience: 'someone-else', expiresIn: '5m' },
    );
    const result = await verifier.verify(token);
    expect(result).toEqual({ ok: false, reason: 'claim_validation_failed' });
  });

  it('rejects an expired token', async () => {
    const verifier = createOAuthVerifier({
      issuer,
      audience,
      jwksUri: `${issuer}/jwks.json`,
      // No clock tolerance, so a token in the past fails immediately.
      clockToleranceSeconds: 0,
    });
    // jose accepts negative expiresIn / past timestamps via setExpirationTime.
    const jwt = new SignJWT({ sub: 'alice' })
      .setProtectedHeader({ alg: 'RS256', kid: key.kid })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 600)
      .setIssuer(issuer)
      .setAudience(audience)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60);
    const token = await jwt.sign(key.privateKey);
    const result = await verifier.verify(token);
    expect(result).toEqual({ ok: false, reason: 'token_expired' });
  });

  it('rejects a token signed by an unknown key', async () => {
    const verifier = createOAuthVerifier({
      issuer,
      audience,
      jwksUri: `${issuer}/jwks.json`,
    });
    // Signed by a key whose JWK is not in the JWKS.
    const token = await sign(otherKey, { sub: 'alice' }, { issuer, audience, expiresIn: '5m' });
    const result = await verifier.verify(token);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // jose can surface this as either no matching key or signature failure
      // depending on whether the kid matches; both are acceptable rejections.
      expect(['unknown_key', 'signature_invalid']).toContain(result.reason);
    }
  });

  it('rejects garbage as `invalid_token`', async () => {
    const verifier = createOAuthVerifier({
      issuer,
      audience,
      jwksUri: `${issuer}/jwks.json`,
    });
    const result = await verifier.verify('not.a.jwt');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_token');
  });

  it('defaults the JWKS URI to issuer/.well-known/jwks.json', async () => {
    // Hot-swap the route on the test server to serve the default path.
    const altServer = createServer((req, res) => {
      if (req.url === '/.well-known/jwks.json') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(jwks));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => altServer.listen(0, '127.0.0.1', () => resolve()));
    const altPort = (altServer.address() as AddressInfo).port;
    const altIssuer = `http://127.0.0.1:${altPort}`;

    try {
      const verifier = createOAuthVerifier({ issuer: altIssuer, audience });
      const token = await sign(
        key,
        { sub: 'alice' },
        { issuer: altIssuer, audience, expiresIn: '5m' },
      );
      const result = await verifier.verify(token);
      expect(result.ok).toBe(true);
    } finally {
      await new Promise<void>((resolve) => altServer.close(() => resolve()));
    }
  });
});
