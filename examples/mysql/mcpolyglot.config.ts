import type { McpolyglotConfig } from '@mcpolyglot/config';

export default {
  server: { name: 'mcpolyglot', version: '0.0.1' },
  transport: { kind: 'stdio' },
  sources: [
    {
      id: 'mysql.main',
      kind: 'mysql',
      url: '${env:DATABASE_URL}',
      scopes: ['schema:read', 'tables:read', 'query:raw'],
      limits: { rowCap: 200, timeoutMs: 10_000, maxBytes: 262144 },
      redact: {
        columns: ['app.users.password_hash', 'app.users.api_key'],
        patterns: [],
      },
    },
  ],
  audit: { path: '~/.mcpolyglot/audit.log' },
  rateLimit: { defaultPerMinute: 30, maxConcurrent: 5 },
  security: { wrapMode: 'strict' },
} satisfies McpolyglotConfig;
