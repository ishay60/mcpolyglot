import sqlParser from 'node-sql-parser';
import { z } from 'zod';
import type { SqlDialect } from './dialect.js';

const { Parser } = sqlParser;
const parser = new Parser();

export const AccessSchema = z.enum(['read', 'write', 'none']);
export type Access = z.infer<typeof AccessSchema>;

export const PolicySchema = z
  .object({
    /** Per-table access. Keys are `table` or `schema.table`, case-insensitive. */
    tables: z.record(z.string(), AccessSchema).default({}),
    /** Access for tables not listed in `tables`. Never `write`: writes are opt-in per table. */
    defaultAccess: z.enum(['read', 'none']).default('read'),
    /** Columns no query may reference, as `table.column` (`*.column` matches any table). */
    denyColumns: z.array(z.string()).default([]),
    maxRows: z.number().int().positive().optional(),
    maxWritesPerCall: z.number().int().positive().default(1),
    statementTimeoutMs: z.number().int().positive().optional(),
    /** How long an `execute` idempotencyKey is remembered. */
    idempotencyWindowMinutes: z.number().positive().default(10),
  })
  .strict();
export type Policy = z.infer<typeof PolicySchema>;

export interface PolicyDecision {
  allow: boolean;
  /** Human-readable reason; always set on deny. */
  reason: string;
  statement?: string;
  tables: { name: string; op: 'read' | 'write' }[];
}

const DB_FOR: Record<SqlDialect['kind'], string> = {
  postgres: 'postgresql',
  mysql: 'mysql',
  mariadb: 'mariadb',
  sqlite: 'sqlite',
};
const WRITE_STATEMENTS = new Set(['insert', 'update', 'delete', 'replace']);

/**
 * Functions no policy may call. They read or write the server's filesystem, reach other
 * hosts, or stall the connection, and a read-only transaction does not stop any of them.
 * This list is defense-in-depth: the database role's privileges are the real control.
 */
export const DENIED_FUNCTIONS: ReadonlySet<string> = new Set([
  // Postgres: server filesystem
  'pg_read_file',
  'pg_read_binary_file',
  'pg_ls_dir',
  'pg_ls_logdir',
  'pg_ls_waldir',
  'pg_ls_tmpdir',
  'pg_ls_archive_statusdir',
  'pg_stat_file',
  'lo_import',
  'lo_export',
  'lo_get',
  'lo_put',
  'lo_from_bytea',
  // Postgres: network / other sessions / server state
  'dblink',
  'dblink_connect',
  'dblink_connect_u',
  'dblink_exec',
  'dblink_open',
  'dblink_fetch',
  'dblink_send_query',
  'pg_terminate_backend',
  'pg_cancel_backend',
  'pg_reload_conf',
  'pg_rotate_logfile',
  'set_config',
  'pg_advisory_lock',
  'pg_advisory_xact_lock',
  'pg_sleep',
  'pg_sleep_for',
  'pg_sleep_until',
  // MySQL / MariaDB
  'load_file',
  'sleep',
  'benchmark',
  'sys_exec',
  'sys_eval',
  'sys_get',
  'sys_set',
  // SQLite
  'load_extension',
  'readfile',
  'writefile',
  'edit',
  'fsdir',
]);

/** Schemas hidden from every policy unless a `tables` key names one of their tables. */
const SYSTEM_SCHEMAS = new Set([
  'information_schema',
  'pg_catalog',
  'mysql',
  'performance_schema',
  'sys',
]);
const SYSTEM_TABLE_PREFIXES = ['pg_', 'sqlite_'];

/** Classify one SQL string against a policy. Pure: never touches the database. */
export function classify(sql: string, policy: Policy, dialect: SqlDialect['kind']): PolicyDecision {
  const opt = { database: DB_FOR[dialect] };
  const deny = (reason: string, extra: Partial<PolicyDecision> = {}): PolicyDecision => ({
    allow: false,
    reason,
    tables: [],
    ...extra,
  });

  let ast: unknown;
  let tableRefs: string[];
  let columnRefs: string[];
  try {
    ast = parser.astify(sql, opt);
    tableRefs = parser.tableList(sql, opt);
    columnRefs = parser.columnList(sql, opt);
  } catch (err) {
    // Unparseable SQL is denied: anything the classifier can't see, it can't vouch for.
    return deny(`Could not parse SQL as ${dialect}: ${(err as Error).message.slice(0, 200)}`);
  }

  const stmts = (Array.isArray(ast) ? ast : [ast]) as Array<{
    type?: string;
    where?: unknown;
    into?: { keyword?: unknown; expr?: unknown; type?: unknown } | null;
  }>;
  if (stmts.length !== 1) return deny(`Exactly one statement per call; got ${stmts.length}.`);
  const stmt = stmts[0]!;
  const type = String(stmt.type ?? 'unknown').toLowerCase();

  if (type !== 'select' && !WRITE_STATEMENTS.has(type)) {
    return deny(`"${type.toUpperCase()}" statements are always blocked (DDL/admin).`, {
      statement: type,
    });
  }
  if ((type === 'update' || type === 'delete') && !stmt.where) {
    return deny(`${type.toUpperCase()} without a WHERE clause is blocked.`, { statement: type });
  }
  if ((type === 'update' || type === 'delete') && !referencesColumn(stmt.where)) {
    return deny(
      `${type.toUpperCase()} with a WHERE clause that names no column (e.g. WHERE 1=1) is blocked.`,
      { statement: type },
    );
  }
  // `SELECT ... INTO OUTFILE/DUMPFILE` (MySQL) and `SELECT ... INTO newtable` (Postgres) write
  // to the server even inside a read-only transaction.
  if (stmt.into && (stmt.into.keyword || stmt.into.expr || stmt.into.type)) {
    return deny(`SELECT ... INTO is blocked; it writes to the server.`, { statement: type });
  }
  const fn = findDeniedFunction(ast);
  if (fn) {
    return deny(`Function "${fn}" is always blocked (file, network, or server access).`, {
      statement: type,
    });
  }

  const tables: PolicyDecision['tables'] = [];
  for (const ref of tableRefs) {
    const [rawOp, schema, name] = ref.split('::') as [string, string, string];
    const op = WRITE_STATEMENTS.has(rawOp.toLowerCase()) ? 'write' : 'read';
    const qualified = schema && schema !== 'null' ? `${schema}.${name}` : name;
    tables.push({ name: qualified, op });

    if (isSystemTable(schema, name) && !explicitlyListed(policy, schema, name)) {
      return deny(`System table "${qualified}" is hidden; list it in policy.tables to expose it.`, {
        statement: type,
        tables,
      });
    }

    const access = tableAccess(policy, schema, name);
    if (access === 'none') {
      return deny(`Table "${qualified}" is not accessible under this policy.`, {
        statement: type,
        tables,
      });
    }
    if (op === 'write' && access !== 'write') {
      return deny(`Table "${qualified}" is read-only under this policy; ${type} denied.`, {
        statement: type,
        tables,
      });
    }
  }

  const denied = policy.denyColumns.map((c) => {
    const i = c.lastIndexOf('.');
    return { table: c.slice(0, i).toLowerCase(), column: c.slice(i + 1).toLowerCase() };
  });
  if (denied.length > 0) {
    const referenced = tables.map((t) => t.name.split('.').pop()!.toLowerCase());
    // A column with no table qualifier could come from any referenced table, so it's
    // checked against all of them.
    const deniedFor = (table: string | null) =>
      denied.filter(
        (d) =>
          d.table === '*' ||
          (table === null ? referenced.includes(bareName(d.table)) : bareName(d.table) === table),
      );

    // A bare identifier that names a table or alias in FROM is a whole-row reference
    // (`SELECT u FROM users u`, `to_jsonb(u)`, `u::text`): every column, including denied
    // ones, comes back inside one value. Treat it like `SELECT *` on that table.
    const rowRefs = tableNamesAndAliases(ast, referenced);
    for (const ref of columnRefs) {
      const [refOp, rawTable, rawCol] = ref.split('::') as [string, string, string];
      // DELETE reports `table.(.*)` but returns no columns; its WHERE refs are still checked.
      if (refOp === 'delete' && rawCol === '(.*)') continue;
      let table = rawTable === 'null' ? null : bareName(rawTable.toLowerCase());
      let col = rawCol.toLowerCase();
      let wholeRow = col === '(.*)';
      if (table === null && !wholeRow && rowRefs.has(col)) {
        table = rowRefs.get(col)!;
        col = '(.*)';
        wholeRow = true;
      }
      const hits = deniedFor(table);
      const hit = wholeRow ? hits[0] : hits.find((d) => d.column === col);
      if (hit) {
        const what =
          rawCol === '(.*)'
            ? `SELECT * would expose`
            : wholeRow
              ? `Whole-row reference "${rawCol}" would expose`
              : `Query references`;
        return deny(
          `${what} denied column "${hit.table}.${hit.column}". List allowed columns explicitly.`,
          { statement: type, tables },
        );
      }
    }
  }

  return { allow: true, reason: 'Allowed by policy.', statement: type, tables };
}

const RANK: Record<Access, number> = { none: 0, read: 1, write: 2 };

function isSystemTable(schema: string, name: string): boolean {
  const s = schema && schema !== 'null' ? schema.toLowerCase() : null;
  if (s) return SYSTEM_SCHEMAS.has(s);
  const n = name.toLowerCase();
  return SYSTEM_TABLE_PREFIXES.some((p) => n.startsWith(p));
}

function explicitlyListed(policy: Policy, schema: string, name: string): boolean {
  const bare = name.toLowerCase();
  const qualified = schema && schema !== 'null' ? `${schema}.${name}`.toLowerCase() : undefined;
  return Object.keys(policy.tables).some((k) => {
    const key = k.toLowerCase();
    return key === bare || key === qualified;
  });
}

/** Depth-first walk over every object/array in the AST. */
function* walk(node: unknown, seen = new Set<object>()): Generator<Record<string, unknown>> {
  if (node === null || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child, seen);
    return;
  }
  const obj = node as Record<string, unknown>;
  yield obj;
  for (const v of Object.values(obj)) yield* walk(v, seen);
}

/** Function name from the several shapes node-sql-parser uses. */
function functionName(node: Record<string, unknown>): string | null {
  const n = node.name;
  if (typeof n === 'string') return n.toLowerCase();
  if (n && typeof n === 'object') {
    const parts = (n as { name?: unknown }).name;
    if (Array.isArray(parts)) {
      const last = parts[parts.length - 1] as { value?: unknown } | undefined;
      if (last && typeof last.value === 'string') return last.value.toLowerCase();
    }
  }
  return null;
}

function findDeniedFunction(ast: unknown): string | null {
  for (const node of walk(ast)) {
    if (node.type !== 'function' && node.type !== 'aggr_func') continue;
    const name = functionName(node);
    if (name && DENIED_FUNCTIONS.has(name)) return name;
  }
  return null;
}

function referencesColumn(where: unknown): boolean {
  for (const node of walk(where)) if (node.type === 'column_ref') return true;
  return false;
}

/**
 * Map of every bare name the query can use as a whole-row reference (table names and
 * FROM aliases, lowercased) to the underlying table's bare name.
 */
function tableNamesAndAliases(ast: unknown, referenced: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of referenced) out.set(t, t);
  for (const node of walk(ast)) {
    if (typeof node.table !== 'string') continue;
    const table = bareName(node.table.toLowerCase());
    if (typeof node.as === 'string') out.set(node.as.toLowerCase(), table);
  }
  return out;
}

/**
 * Every policy key that could name this table matches; the most restrictive wins. An
 * unqualified `users` therefore can't dodge a `public.users: none` rule.
 */
export function tableAccess(policy: Policy, schema: string, name: string): Access {
  const bare = name.toLowerCase();
  const qualified = schema && schema !== 'null' ? `${schema}.${name}`.toLowerCase() : undefined;
  const matches = Object.entries(policy.tables)
    .filter(([k]) => {
      const key = k.toLowerCase();
      return key === bare || key === qualified || (!qualified && bareName(key) === bare);
    })
    .map(([, v]) => v);
  if (matches.length === 0) return policy.defaultAccess;
  return matches.reduce((a, b) => (RANK[a] <= RANK[b] ? a : b));
}

function bareName(t: string): string {
  return t.split('.').pop()!;
}

export function isColumnDenied(policy: Policy, table: string, column: string): boolean {
  const t = bareName(table.toLowerCase());
  const c = column.toLowerCase();
  return policy.denyColumns.some((d) => {
    const i = d.lastIndexOf('.');
    const dt = d.slice(0, i).toLowerCase();
    return d.slice(i + 1).toLowerCase() === c && (dt === '*' || bareName(dt) === t);
  });
}

/**
 * Combine a source policy with a per-agent override so the result is never more
 * permissive than either: per table the most restrictive access wins, deny lists are
 * unioned, and every cap takes the smaller value.
 */
export function narrowPolicy(base: Policy, override: Policy): Policy {
  const lookup = (p: Policy, key: string) => {
    const i = key.lastIndexOf('.');
    return i < 0 ? tableAccess(p, 'null', key) : tableAccess(p, key.slice(0, i), key.slice(i + 1));
  };
  const stricter = (a: Access, b: Access) => (RANK[a] <= RANK[b] ? a : b);
  const min = (a?: number, b?: number) =>
    a === undefined ? b : b === undefined ? a : Math.min(a, b);

  const tables: Record<string, Access> = {};
  for (const key of new Set([...Object.keys(base.tables), ...Object.keys(override.tables)])) {
    tables[key] = stricter(lookup(base, key), lookup(override, key));
  }
  const maxRows = min(base.maxRows, override.maxRows);
  const statementTimeoutMs = min(base.statementTimeoutMs, override.statementTimeoutMs);
  return {
    tables,
    defaultAccess:
      RANK[base.defaultAccess] <= RANK[override.defaultAccess]
        ? base.defaultAccess
        : override.defaultAccess,
    denyColumns: [...new Set([...base.denyColumns, ...override.denyColumns])],
    maxWritesPerCall: Math.min(base.maxWritesPerCall, override.maxWritesPerCall),
    idempotencyWindowMinutes: Math.min(
      base.idempotencyWindowMinutes,
      override.idempotencyWindowMinutes,
    ),
    ...(maxRows !== undefined && { maxRows }),
    ...(statementTimeoutMs !== undefined && { statementTimeoutMs }),
  };
}
