import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { TableSchema } from '@mcpolyglot/core';
import { looksLikeLiteralCredential, resolveSecrets } from '@mcpolyglot/config';
import {
  MysqlDialect,
  PostgresDialect,
  SqliteDialect,
  type Policy,
  type SqlDialect,
} from '@mcpolyglot/connector-sql';
import { headerBar, panel, footerBar, step, chip, stdoutSink } from '../ui.js';

type SqlKind = SqlDialect['kind'];

export interface InitOptions {
  cwd: string;
  /** DB URL (or SQLite path). When set, init introspects it and skips the prompts. */
  url?: string;
  id?: string;
}

/** Column names that usually hold secrets or PII. A suggestion, not a guarantee. */
// ponytail: name-only heuristic; misses e.g. `notes` holding secrets. Values are never sampled.
const SENSITIVE_COLUMN =
  /pass(word|wd)?|pwd|secret|token|ssn|social_?security|api_?key|hash|salt|private_?key|card_?number|cvv|otp|mfa/i;

export function inferKind(url: string): SqlKind {
  if (/^postgres(ql)?:\/\//i.test(url)) return 'postgres';
  if (/^mysql:\/\//i.test(url)) return 'mysql';
  if (/^mariadb:\/\//i.test(url)) return 'mariadb';
  return 'sqlite';
}

/** Every table explicitly `read`, unknown tables hidden, sensitive-looking columns denied. */
export function generatePolicy(
  tables: TableSchema[],
): Pick<Policy, 'tables' | 'defaultAccess' | 'denyColumns'> {
  const key = (t: TableSchema) => (t.schema ? `${t.schema}.${t.name}` : t.name);
  return {
    defaultAccess: 'none',
    tables: Object.fromEntries(tables.map((t) => [key(t), 'read' as const])),
    denyColumns: tables.flatMap((t) =>
      t.columns.filter((c) => SENSITIVE_COLUMN.test(c.name)).map((c) => `${key(t)}.${c.name}`),
    ),
  };
}

async function introspect(kind: SqlKind, url: string): Promise<TableSchema[]> {
  const resolved = await resolveSecrets(url);
  const dialect =
    kind === 'postgres'
      ? new PostgresDialect(resolved)
      : kind === 'sqlite'
        ? new SqliteDialect(resolved)
        : new MysqlDialect(resolved);
  await dialect.connect();
  try {
    return await dialect.listTables();
  } finally {
    await dialect.close();
  }
}

export async function initCommand(opts: InitOptions): Promise<void> {
  headerBar(
    {
      version: '0.0.1',
      command: 'init',
      subtitle: 'scaffold mcpolyglot.config.ts in this directory',
    },
    stdoutSink,
  );

  const target = resolve(opts.cwd, 'mcpolyglot.config.ts');
  if (opts.url) return initFromUrl(opts, opts.url, target);
  if (existsSync(target)) {
    const proceed = await p.confirm({
      message: `mcpolyglot.config.ts already exists in ${opts.cwd}. Overwrite?`,
      initialValue: false,
    });
    if (p.isCancel(proceed) || !proceed) {
      p.cancel('Aborted.');
      return;
    }
  }

  step(1, 3, 'Pick a data source', stdoutSink);
  const kind = await p.select({
    message: 'Pick a data source to start with:',
    options: [
      { value: 'postgres', label: 'PostgreSQL', hint: 'recommended' },
      { value: 'sqlite', label: 'SQLite', hint: 'local file, fastest demo' },
    ],
  });
  if (p.isCancel(kind)) {
    p.cancel('Aborted.');
    return;
  }

  step(2, 3, 'Name the source', stdoutSink);
  const id = await p.text({
    message: 'Source id (used in tool names):',
    initialValue: kind === 'postgres' ? 'pg.main' : 'sqlite.local',
    validate: (v) =>
      v && /^[a-z0-9._-]+$/i.test(v) ? undefined : 'Use letters, digits, dot, hyphen, underscore.',
  });
  if (p.isCancel(id)) return;

  step(3, 3, 'Connection', stdoutSink);
  let url: string;
  if (kind === 'postgres') {
    url = '${env:DATABASE_URL}';
    p.note(
      `Set ${pc.cyan('DATABASE_URL')} in your environment before running ${pc.bold('mcpolyglot serve')}.`,
      'Example',
    );
  } else {
    const path = await p.text({
      message: 'Path to SQLite file:',
      placeholder: './data.db',
      validate: (v) => (v && v.length > 0 ? undefined : 'Required.'),
    });
    if (p.isCancel(path)) return;
    url = path;
  }

  const config = renderConfig({ kind: kind as 'postgres' | 'sqlite', id: id as string, url });
  writeFileSync(target, config, 'utf8');
  printNext(target);
}

async function initFromUrl(opts: InitOptions, url: string, target: string): Promise<void> {
  if (existsSync(target)) {
    throw new Error(`${target} already exists; move it aside first.`);
  }
  const kind = inferKind(url);
  step(1, 2, `Introspect ${kind}`, stdoutSink);
  const tables = await introspect(kind, url);
  const policy = generatePolicy(tables);
  stdoutSink(
    `  ${chip('OK', 'ok')}  ${tables.length} tables, ${policy.denyColumns.length} sensitive-looking columns`,
  );

  step(2, 2, 'Write config', stdoutSink);
  // Never write a literal password into the config; point at the env var instead.
  const safeUrl =
    kind !== 'sqlite' && looksLikeLiteralCredential(url) ? '${env:DATABASE_URL}' : url;
  if (safeUrl !== url) {
    p.note(`Set ${pc.cyan('DATABASE_URL')} to your connection string before serving.`, 'Secret');
  }
  const id = opts.id ?? (kind === 'sqlite' ? 'sqlite.local' : `${kind}.main`);
  writeFileSync(target, renderConfig({ kind, id, url: safeUrl, policy }), 'utf8');
  printNext(target);
}

function printNext(target: string): void {
  stdoutSink('');
  stdoutSink(`  ${chip('OK', 'ok')}  wrote ${pc.bold(target)}`);

  panel(
    {
      title: 'Next',
      lines: [
        `${pc.dim('▸')} ${pc.bold('Validate'.padEnd(10))} ${pc.cyan('mcpolyglot doctor')}`,
        `${pc.dim('▸')} ${pc.bold('List'.padEnd(10))} ${pc.cyan('mcpolyglot tools')}`,
        `${pc.dim('▸')} ${pc.bold('Run'.padEnd(10))} ${pc.cyan('mcpolyglot serve')}`,
      ],
    },
    stdoutSink,
  );

  panel(
    {
      title: 'Wire into your agent',
      lines: [
        `${pc.bold('Claude Desktop')}  ${pc.dim('~/Library/Application Support/Claude/claude_desktop_config.json')}`,
        `${pc.bold('Cursor')}         ${pc.dim('~/.cursor/mcp.json')}`,
        `${pc.bold('Claude Code')}    ${pc.dim('claude mcp add mcpolyglot -- npx -y @mcpolyglot/cli serve')}`,
      ],
    },
    stdoutSink,
  );

  footerBar(['docs: github.com/ishay60/mcpolyglot'], stdoutSink);
}

export function renderConfig(opts: {
  kind: SqlKind;
  id: string;
  url: string;
  policy?: ReturnType<typeof generatePolicy>;
}): string {
  // Type-only import: erased at load time, so the file runs under npx without
  // @mcpolyglot/config installed next to it. Install it for editor autocomplete.
  return `import type { McpolyglotConfig } from '@mcpolyglot/config';

export default {
  server: { name: 'mcpolyglot', version: '0.0.1' },
  transport: { kind: 'stdio' },
  sources: [
    {
      id: '${opts.id}',
      kind: '${opts.kind}',
      url: '${opts.url}',
      scopes: ['schema:read', 'tables:read', 'query:raw'],
      perEntityTools: { enabled: false },
      limits: { rowCap: 200, timeoutMs: 10_000, maxBytes: 262144 },
      redact: {
        columns: [],
        patterns: [],
      },${opts.policy ? renderPolicy(opts.policy) : ''}
    },
  ],
  audit: { path: '~/.mcpolyglot/audit.log' },
  rateLimit: { defaultPerMinute: 30, maxConcurrent: 5 },
  security: { wrapMode: 'strict' },
} satisfies McpolyglotConfig;
`;
}

function renderPolicy(policy: ReturnType<typeof generatePolicy>): string {
  const q = JSON.stringify;
  const tables = Object.keys(policy.tables).map((t) => `\n          ${q(t)}: 'read',`);
  const denies = policy.denyColumns.map((c) => `\n          ${q(c)},`);
  return `
      policy: {
        // Tables not listed below are hidden. Add new tables here explicitly.
        defaultAccess: 'none',
        // Every table is read-only. Set a table to 'write' only if an agent must modify it.
        tables: {${tables.join('')}
        },
        // Suggested from column names (password, token, ssn, hash, ...). Review: keep, add, remove.
        denyColumns: [${denies.join('')}
        ],
      },`;
}
