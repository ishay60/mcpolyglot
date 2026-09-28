import {
  McpolyglotServer,
  type Connector,
  type SecurityHooks,
  ConfigError,
} from '@mcpolyglot/core';
import {
  type McpolyglotConfig,
  type SourceConfig,
  type SqlSourceConfig,
  resolveSecrets,
} from '@mcpolyglot/config';
import { defaultSecurityHooks } from '@mcpolyglot/security';
import {
  MysqlDialect,
  PolicySchema,
  PostgresDialect,
  SqlConnector,
  SqliteDialect,
} from '@mcpolyglot/connector-sql';
import { MongoConnector } from '@mcpolyglot/connector-mongo';

export interface BuiltServer {
  server: McpolyglotServer;
  hooks: SecurityHooks;
  connectors: Connector[];
  perEntity: Record<string, { enabled: boolean; include?: string[]; exclude?: string[] }>;
}

export async function buildServerFromConfig(
  cfg: McpolyglotConfig,
  logger = makeStderrLogger(),
): Promise<BuiltServer> {
  const connectors: Connector[] = [];
  const perEntity: BuiltServer['perEntity'] = {};

  for (const src of cfg.sources) {
    connectors.push(await buildConnector(src));
    if (src.kind !== 'mongo' && src.kind !== 'openapi') {
      const sql = src as SqlSourceConfig;
      if (sql.perEntityTools.enabled) {
        perEntity[sql.id] = {
          enabled: true,
          include: sql.perEntityTools.include,
          exclude: sql.perEntityTools.exclude,
        };
      }
    }
  }

  const hooks = defaultSecurityHooks({
    rateLimit: {
      perMinute: cfg.rateLimit.defaultPerMinute,
      maxConcurrent: cfg.rateLimit.maxConcurrent,
    },
    audit: {
      // stdout carries the MCP protocol under stdio, so audit goes to stderr there.
      console: cfg.audit.console ? (cfg.transport.kind === 'stdio' ? 'stderr' : 'stdout') : false,
      ...(cfg.audit.path ? { path: cfg.audit.path } : {}),
      ...(cfg.audit.webhookUrl
        ? { webhook: { url: await resolveSecrets(cfg.audit.webhookUrl) } }
        : {}),
    },
    redactor: {
      denyColumns: collectDenyColumns(cfg.sources),
      customRules: collectCustomRules(cfg.sources),
    },
    wrapMode: cfg.security.wrapMode,
  });

  // Use the first source's limits as the default execution envelope (Wave 1 simplification —
  // per-tool limits arrive in Wave 2).
  const first = cfg.sources[0];
  const defaultLimits = first
    ? {
        rowCap: getLimits(first).rowCap,
        timeoutMs: getLimits(first).timeoutMs,
        maxBytes: getLimits(first).maxBytes,
      }
    : { rowCap: 200, timeoutMs: 10_000, maxBytes: 256 * 1024 };

  const server = new McpolyglotServer({
    name: cfg.server.name,
    version: cfg.server.version,
    connectors,
    perEntity,
    scopes: collectScopes(cfg.sources),
    security: { hooks, defaultLimits, defaultScopes: collectScopes(cfg.sources) },
    logger,
  });

  return { server, hooks, connectors, perEntity };
}

async function buildConnector(src: SourceConfig): Promise<Connector> {
  switch (src.kind) {
    case 'postgres': {
      const url = await resolveSecrets(src.url);
      return new SqlConnector({
        id: src.id,
        dialect: new PostgresDialect(url),
        policy: sqlPolicy(src),
      });
    }
    case 'sqlite': {
      const url = await resolveSecrets(src.url);
      return new SqlConnector({
        id: src.id,
        dialect: new SqliteDialect(url),
        policy: sqlPolicy(src),
      });
    }
    case 'mysql':
    case 'mariadb': {
      const url = await resolveSecrets(src.url);
      return new SqlConnector({
        id: src.id,
        dialect: new MysqlDialect(url),
        policy: sqlPolicy(src),
      });
    }
    case 'mongo': {
      const url = await resolveSecrets(src.url);
      return new MongoConnector({
        id: src.id,
        url,
        ...(src.database ? { database: src.database } : {}),
      });
    }
    case 'openapi':
      throw new ConfigError('OpenAPI connector arrives in Wave 3.');
    default: {
      const _exhaustive: never = src;
      void _exhaustive;
      throw new ConfigError(`Unknown source kind`);
    }
  }
}

function sqlPolicy(src: SqlSourceConfig) {
  if (!src.policy) return undefined;
  const parsed = PolicySchema.safeParse(src.policy);
  if (!parsed.success) {
    throw new ConfigError(`Invalid policy for source "${src.id}": ${parsed.error.message}`);
  }
  return parsed.data;
}

function getLimits(src: SourceConfig): { rowCap: number; timeoutMs: number; maxBytes: number } {
  return src.limits;
}

function collectScopes(sources: SourceConfig[]) {
  const set = new Set<import('@mcpolyglot/core').Scope>();
  for (const s of sources) for (const sc of s.scopes) set.add(sc);
  return Array.from(set);
}

function collectDenyColumns(sources: SourceConfig[]) {
  const out: { path: string }[] = [];
  for (const s of sources) {
    if ('redact' in s && s.redact) {
      for (const c of s.redact.columns) out.push({ path: c });
    }
  }
  return out;
}

function collectCustomRules(sources: SourceConfig[]) {
  const out: { name: string; regex: RegExp; replacement?: string }[] = [];
  for (const s of sources) {
    if ('redact' in s && s.redact) {
      for (const p of s.redact.patterns) {
        out.push({
          name: p.name,
          regex: new RegExp(p.regex, 'g'),
          ...(p.replacement !== undefined ? { replacement: p.replacement } : {}),
        });
      }
    }
  }
  return out;
}

function makeStderrLogger() {
  const w = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    const line = JSON.stringify({ level, msg, ...(fields ?? {}) });
    process.stderr.write(line + '\n');
  };
  return { debug: w('debug'), info: w('info'), warn: w('warn'), error: w('error') };
}
