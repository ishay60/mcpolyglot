import {
  McpolyglotServer,
  type AgentGrant,
  type Connector,
  type Scope,
  type SecurityHooks,
  ConfigError,
} from '@mcpolyglot/core';
import {
  type McpolyglotConfig,
  type SourceConfig,
  type SqlSourceConfig,
  type AgentConfig,
  resolveSecrets,
} from '@mcpolyglot/config';
import { defaultSecurityHooks } from '@mcpolyglot/security';
import {
  MysqlDialect,
  narrowPolicy,
  PolicySchema,
  PostgresDialect,
  SqlConnector,
  SqliteDialect,
} from '@mcpolyglot/connector-sql';
import { MongoConnector } from '@mcpolyglot/connector-mongo';
import { OpenApiConnector, type OpenApiAuth } from '@mcpolyglot/connector-openapi';

export interface BuiltServer {
  server: McpolyglotServer;
  hooks: SecurityHooks;
  connectors: Connector[];
  /** Present when `cfg.agents` is set. */
  agents?: AgentGrant[];
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

  const agents = cfg.agents ? await buildAgents(cfg, connectors) : undefined;

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
    ...(agents ? { agents } : {}),
    logger,
  });

  return { server, hooks, connectors, ...(agents ? { agents } : {}), perEntity };
}

/**
 * One grant per agent. A source listed without a policy reuses the shared connector (and its
 * pool); a per-agent policy gets its own connector — and its own DB connection.
 */
async function buildAgents(cfg: McpolyglotConfig, shared: Connector[]): Promise<AgentGrant[]> {
  const ids = new Set<string>();
  const hashes = new Set<string>();
  const out: AgentGrant[] = [];
  for (const a of cfg.agents ?? []) {
    if (ids.has(a.id)) throw new ConfigError(`Duplicate agent id "${a.id}"`);
    ids.add(a.id);
    for (const t of a.tokens) {
      if (hashes.has(t.hash)) throw new ConfigError(`Agent "${a.id}" reuses a token hash`);
      hashes.add(t.hash);
    }
    const sources: SourceConfig[] = [];
    const connectors: Connector[] = [];
    for (const [srcId, override] of Object.entries(a.sources)) {
      const i = cfg.sources.findIndex((s) => s.id === srcId);
      const src = cfg.sources[i];
      if (!src) throw new ConfigError(`Agent "${a.id}" lists unknown source "${srcId}"`);
      sources.push(src);
      if (!override.policy) {
        connectors.push(shared[i]!);
      } else if (src.kind === 'mongo' || src.kind === 'openapi') {
        throw new ConfigError(`Agent "${a.id}": policy is only supported on SQL sources`);
      } else {
        // An agent's policy can only narrow the source's, never widen it.
        const agentPolicy = PolicySchema.safeParse(override.policy);
        if (!agentPolicy.success) {
          throw new ConfigError(
            `Invalid policy for agent "${a.id}" on "${srcId}": ${agentPolicy.error.message}`,
          );
        }
        const base = sqlPolicy(src) ?? PolicySchema.parse({});
        connectors.push(
          await buildConnector({ ...src, policy: narrowPolicy(base, agentPolicy.data) }),
        );
      }
    }
    out.push({ id: a.id, scopes: agentScopes(a, sources), connectors });
  }
  return out;
}

async function buildConnector(src: SourceConfig): Promise<Connector> {
  switch (src.kind) {
    case 'postgres':
    case 'sqlite':
    case 'mysql':
    case 'mariadb': {
      const url = await resolveSecrets(src.url);
      const dialect =
        src.kind === 'postgres'
          ? new PostgresDialect(url, src.pool)
          : src.kind === 'sqlite'
            ? new SqliteDialect(url)
            : new MysqlDialect(url, src.pool);
      return new SqlConnector({
        id: src.id,
        dialect,
        policy: sqlPolicy(src),
        ...(src.maxConcurrentQueries ? { maxConcurrentQueries: src.maxConcurrentQueries } : {}),
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
    case 'openapi': {
      const auth = { ...src.auth } as Record<string, string>;
      for (const k of ['token', 'value', 'password']) {
        if (auth[k] !== undefined) auth[k] = await resolveSecrets(auth[k]);
      }
      return new OpenApiConnector({
        id: src.id,
        spec: src.spec,
        baseUrl: src.baseUrl,
        auth: auth as OpenApiAuth,
        allowMethods: src.allowMethods,
      });
    }
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

/** An agent never gets a scope its sources don't grant. */
export function agentScopes(agent: AgentConfig, sources: SourceConfig[]): Scope[] {
  const allowed = collectScopes(sources);
  return agent.scopes ? agent.scopes.filter((s) => allowed.includes(s)) : allowed;
}

function getLimits(src: SourceConfig): { rowCap: number; timeoutMs: number; maxBytes: number } {
  return src.limits;
}

function collectScopes(sources: SourceConfig[]) {
  const set = new Set<Scope>();
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
