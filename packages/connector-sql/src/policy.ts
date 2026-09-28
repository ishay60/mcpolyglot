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

  const stmts = (Array.isArray(ast) ? ast : [ast]) as Array<{ type?: string; where?: unknown }>;
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

  const tables: PolicyDecision['tables'] = [];
  for (const ref of tableRefs) {
    const [rawOp, schema, name] = ref.split('::') as [string, string, string];
    const op = WRITE_STATEMENTS.has(rawOp.toLowerCase()) ? 'write' : 'read';
    const qualified = schema && schema !== 'null' ? `${schema}.${name}` : name;
    tables.push({ name: qualified, op });

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

    for (const ref of columnRefs) {
      const [refOp, rawTable, rawCol] = ref.split('::') as [string, string, string];
      // DELETE reports `table.(.*)` but returns no columns; its WHERE refs are still checked.
      if (refOp === 'delete' && rawCol === '(.*)') continue;
      const table = rawTable === 'null' ? null : bareName(rawTable.toLowerCase());
      const col = rawCol.toLowerCase();
      const hits = deniedFor(table);
      const hit = col === '(.*)' ? hits[0] : hits.find((d) => d.column === col);
      if (hit) {
        const what = col === '(.*)' ? `SELECT * would expose` : `Query references`;
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
