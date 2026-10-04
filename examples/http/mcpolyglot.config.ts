import type { McpolyglotConfig } from '@mcpolyglot/config';

export default {
  server: { name: 'mcpolyglot', version: '0.0.1' },
  transport: {
    kind: 'http',
    host: '127.0.0.1', // bind to loopback by default; put behind a TLS proxy for non-local
    port: 7337,
    auth: {
      type: 'bearer',
      // Pin a long-lived token via env so clients have something stable to send.
      // Omit this whole `token` line and mcpolyglot will mint a fresh token on each
      // start and print it on stderr (great for ad-hoc, useless for clients).
      token: '${env:MCPOLYGLOT_BEARER_TOKEN}',
    },
  },
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
  audit: { path: '~/.mcpolyglot/audit.log' },
  rateLimit: { defaultPerMinute: 60, maxConcurrent: 8 },
  security: { wrapMode: 'strict' },
} satisfies McpolyglotConfig;
