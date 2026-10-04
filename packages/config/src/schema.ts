import { existsSync, readFileSync } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ALL_SCOPES, ConfigError } from '@mcpolyglot/core';

const ScopeSchema = z.enum(ALL_SCOPES);

const RedactSchema = z
  .object({
    columns: z.array(z.string()).default([]),
    patterns: z
      .array(
        z.object({
          name: z.string(),
          regex: z.string(),
          replacement: z.string().optional(),
        }),
      )
      .default([]),
  })
  .default({ columns: [], patterns: [] });

const LimitsSchema = z
  .object({
    rowCap: z.number().int().positive().max(10_000).default(200),
    timeoutMs: z.number().int().positive().max(60_000).default(10_000),
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(8 * 1024 * 1024)
      .default(256 * 1024),
  })
  .default({ rowCap: 200, timeoutMs: 10_000, maxBytes: 256 * 1024 });

const SqlSourceSchema = z.object({
  id: z.string().regex(/^[a-z0-9._-]+$/i),
  kind: z.enum(['postgres', 'mysql', 'mariadb', 'sqlite']),
  url: z.string().min(1),
  scopes: z.array(ScopeSchema).default(['schema:read', 'tables:read']),
  limits: LimitsSchema,
  redact: RedactSchema,
  /** Access policy; validated strictly by `@mcpolyglot/connector-sql` at startup. */
  policy: z.record(z.string(), z.unknown()).optional(),
  /** Driver pool. SQLite ignores it (one handle). */
  pool: z
    .object({
      max: z.number().int().positive().max(100).optional(),
      idleTimeoutMs: z.number().int().positive().optional(),
    })
    .strict()
    .optional(),
  /** Calls beyond this many in flight on this source are rejected with `rate_limited`. */
  maxConcurrentQueries: z.number().int().positive().optional(),
});

const MongoSourceSchema = z.object({
  id: z.string().regex(/^[a-z0-9._-]+$/i),
  kind: z.literal('mongo'),
  url: z.string().min(1),
  database: z.string().optional(),
  scopes: z.array(ScopeSchema).default(['schema:read', 'tables:read']),
  limits: LimitsSchema,
  redact: RedactSchema,
});

const OpenApiSourceSchema = z.object({
  id: z.string().regex(/^[a-z0-9._-]+$/i),
  kind: z.literal('openapi'),
  spec: z.string(),
  baseUrl: z.string().url(),
  auth: z
    .union([
      z.object({ type: z.literal('none') }),
      z.object({ type: z.literal('bearer'), token: z.string() }),
      z.object({ type: z.literal('apiKey'), header: z.string(), value: z.string() }),
      z.object({ type: z.literal('basic'), username: z.string(), password: z.string() }),
    ])
    .default({ type: 'none' }),
  allowMethods: z
    .array(z.enum(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']))
    .default(['GET', 'HEAD', 'OPTIONS']),
  scopes: z.array(ScopeSchema).default(['http:call']),
  limits: LimitsSchema,
  redact: RedactSchema,
});

const TransportSchema = z.union([
  z.object({ kind: z.literal('stdio') }),
  z.object({
    kind: z.literal('http'),
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(7337),
    auth: z
      .union([
        z.object({ type: z.literal('bearer'), token: z.string().optional() }),
        z.object({
          type: z.literal('oauth'),
          issuer: z.string().url(),
          audience: z.string(),
          jwksUri: z.string().url().optional(),
        }),
      ])
      .default({ type: 'bearer' }),
  }),
]);

const AgentSchema = z.object({
  id: z.string().regex(/^[a-z0-9._-]+$/i),
  /** Several tokens allow rotation: add the new one, roll clients over, revoke the old. */
  tokens: z
    .array(
      z.object({
        /** sha256 of the token, lowercase hex. The token itself never goes in config. */
        hash: z.string().regex(/^[0-9a-f]{64}$/, 'expected a lowercase sha256 hex digest'),
        label: z.string().optional(),
        revoked: z.boolean().default(false),
      }),
    )
    .min(1),
  /** Defaults to (and is always capped at) the union of this agent's sources' scopes. */
  scopes: z.array(ScopeSchema).optional(),
  /** Sources this agent can see. `policy` replaces the source's own policy for this agent. */
  sources: z
    .record(z.string(), z.object({ policy: z.record(z.string(), z.unknown()).optional() }))
    .default({}),
});

export const ConfigSchema = z.object({
  server: z
    .object({
      name: z.string().default('mcpolyglot'),
      version: z.string().default('0.0.1'),
    })
    .default({ name: 'mcpolyglot', version: '0.0.1' }),
  transport: TransportSchema.default({ kind: 'stdio' }),
  sources: z.array(z.union([SqlSourceSchema, MongoSourceSchema, OpenApiSourceSchema])).min(1),
  audit: z
    .object({
      /** JSONL to stdout (stderr under the stdio transport). */
      console: z.boolean().default(true),
      /** Also append JSONL to this file. */
      path: z.string().optional(),
      /** Also POST each entry as JSON. Supports `${env:NAME}`. */
      webhookUrl: z.string().optional(),
    })
    .default({ console: true }),
  rateLimit: z
    .object({
      defaultPerMinute: z.number().int().positive().default(30),
      maxConcurrent: z.number().int().positive().default(5),
    })
    .default({ defaultPerMinute: 30, maxConcurrent: 5 }),
  security: z
    .object({
      wrapMode: z.enum(['strict', 'off']).default('strict'),
    })
    .default({ wrapMode: 'strict' }),
  /** Per-agent tokens, sources and scopes for the HTTP transport. Ignored under stdio. */
  agents: z.array(AgentSchema).optional(),
});

export type McpolyglotConfig = z.infer<typeof ConfigSchema>;
export type SqlSourceConfig = z.infer<typeof SqlSourceSchema>;
export type MongoSourceConfig = z.infer<typeof MongoSourceSchema>;
export type OpenApiSourceConfig = z.infer<typeof OpenApiSourceSchema>;
export type SourceConfig = SqlSourceConfig | MongoSourceConfig | OpenApiSourceConfig;
export type AgentConfig = z.infer<typeof AgentSchema>;
export type TransportConfig = z.infer<typeof TransportSchema>;

/**
 * Identity helper for type-safe `mcpolyglot.config.ts` files. Wraps the config so editors
 * give you autocomplete and Zod's validation runs at load time rather than crashing later.
 *
 * @example
 * ```ts
 * import { defineConfig } from '@mcpolyglot/config';
 *
 * export default defineConfig({
 *   transport: { kind: 'stdio' },
 *   sources: [{
 *     id: 'pg.main',
 *     kind: 'postgres',
 *     url: '${env:DATABASE_URL}',
 *     scopes: ['schema:read', 'tables:read', 'query:raw'],
 *     limits: { rowCap: 200, timeoutMs: 10_000, maxBytes: 262144 },
 *     redact: { columns: ['public.users.password_hash'], patterns: [] },
 *   }],
 * });
 * ```
 */
export function defineConfig(cfg: McpolyglotConfig | (() => McpolyglotConfig)): McpolyglotConfig {
  return typeof cfg === 'function' ? cfg() : cfg;
}

/**
 * Load and validate a config file. Supports `.ts`, `.mts`, `.js`, `.mjs`, `.cjs`,
 * `.json`, `.yaml`, and `.yml`. TS files require the `tsx` loader (the CLI registers it).
 *
 * @throws {ConfigError} when the file is missing, has an unsupported extension,
 *   or fails Zod validation.
 */
export async function loadConfig(path: string): Promise<McpolyglotConfig> {
  const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
  if (!existsSync(abs)) {
    throw new ConfigError(`Config file not found: ${abs}`);
  }

  const ext = extname(abs).toLowerCase();
  let raw: unknown;

  switch (ext) {
    case '.json':
      raw = JSON.parse(readFileSync(abs, 'utf8'));
      break;
    case '.yaml':
    case '.yml':
      raw = parseYaml(readFileSync(abs, 'utf8'));
      break;
    case '.ts':
    case '.mts': {
      // Best-effort dynamic import. tsx loader (registered by the CLI) handles TS at runtime.
      const mod = (await import(pathToFileURL(abs).href)) as { default?: unknown };
      raw = mod.default ?? mod;
      break;
    }
    case '.js':
    case '.mjs':
    case '.cjs': {
      const mod = (await import(pathToFileURL(abs).href)) as { default?: unknown };
      raw = mod.default ?? mod;
      break;
    }
    default:
      throw new ConfigError(`Unsupported config extension: ${ext}`);
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`Config validation failed: ${parsed.error.message}`, {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}
