import { fileURLToPath } from 'node:url';
import type { McpolyglotConfig } from '@mcpolyglot/config';

export default {
  server: { name: 'mcpolyglot', version: '0.0.1' },
  transport: { kind: 'stdio' },
  sources: [
    {
      id: 'github',
      kind: 'openapi',
      // Absolute, so it loads whatever directory the agent host starts the server from.
      spec: fileURLToPath(new URL('./openapi.yaml', import.meta.url)),
      baseUrl: 'https://api.github.com',
      // Public endpoints need no token. For private repos or a higher rate limit:
      // auth: { type: 'bearer', token: '${env:GITHUB_TOKEN}' },
      auth: { type: 'none' },
      allowMethods: ['GET'],
      scopes: ['http:call'],
      limits: { rowCap: 200, timeoutMs: 10_000, maxBytes: 262144 },
      redact: { columns: [], patterns: [] },
    },
  ],
  audit: { path: '~/.mcpolyglot/audit.log' },
  rateLimit: { defaultPerMinute: 30, maxConcurrent: 5 },
  security: { wrapMode: 'strict' },
} satisfies McpolyglotConfig;
