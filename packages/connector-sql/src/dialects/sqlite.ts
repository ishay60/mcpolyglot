import type { TableSchema, ColumnSchema } from '@mcpolyglot/core';
import { McpolyglotError } from '@mcpolyglot/core';
import { tooManyRows, type SqlDialect, type SqlQueryResult } from '../dialect.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BetterSqlite3Database = any;

export class SqliteDialect implements SqlDialect {
  readonly kind = 'sqlite' as const;
  private db?: BetterSqlite3Database;

  /**
   * @param fileOrUri Either an absolute path or a `sqlite://` URI.
   *                  Opened read-only unless `connect({ writable: true })`.
   */
  constructor(private readonly fileOrUri: string) {}

  async connect({ writable = false }: { writable?: boolean } = {}): Promise<void> {
    const Database = await loadSqlite();
    const path = this.resolvePath();
    const db = new Database(path, { readonly: !writable, fileMustExist: true });
    if (!writable) db.pragma('query_only = ON');
    this.db = db;
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = undefined;
  }

  async ping(): Promise<{ ok: boolean; latencyMs: number; details?: string }> {
    const t0 = Date.now();
    try {
      this.requireDb().prepare('SELECT 1').get();
      return { ok: true, latencyMs: Date.now() - t0 };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - t0, details: (err as Error).message };
    }
  }

  async listTables(): Promise<TableSchema[]> {
    const db = this.requireDb();
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;

    return tables.map(({ name }) => {
      const cols = db.prepare(`PRAGMA table_info(${quoteIdent(name)})`).all() as Array<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }>;
      const columns: ColumnSchema[] = cols.map((c) => ({
        name: c.name,
        type: c.type || 'ANY',
        nullable: c.notnull === 0,
        primaryKey: c.pk > 0,
      }));
      return { name, columns };
    });
  }

  async runReadOnly(
    sql: string,
    params: ReadonlyArray<unknown>,
    opts: { rowCap: number; timeoutMs: number; signal?: AbortSignal },
  ): Promise<SqlQueryResult> {
    const db = this.requireDb();
    if (opts.signal?.aborted) throw new McpolyglotError('aborted', 'Aborted before execution');

    // SQLite is synchronous via better-sqlite3 — `query_only` pragma + readonly handle blocks writes.
    const stmt = db.prepare(sql);
    if (!stmt.reader) {
      throw new McpolyglotError('forbidden.read_only', 'Statement is not read-only');
    }
    const startedAt = Date.now();
    const all = stmt.all(...(params as unknown[])) as Array<Record<string, unknown>>;
    if (Date.now() - startedAt > opts.timeoutMs) {
      throw new McpolyglotError('timeout', `Query exceeded ${opts.timeoutMs}ms`);
    }
    const truncated = all.length > opts.rowCap;
    const rows = truncated ? all.slice(0, opts.rowCap) : all;
    const columns = rows[0]
      ? Object.keys(rows[0])
      : ((stmt.columns() as Array<{ name: string }>).map((c) => c.name) ?? []);
    return { columns, rows, rowCount: rows.length, truncated };
  }

  async runWrite(
    sql: string,
    params: ReadonlyArray<unknown>,
    opts: { maxRowsAffected: number; timeoutMs: number; signal?: AbortSignal },
  ): Promise<{ rowsAffected: number }> {
    const db = this.requireDb();
    if (opts.signal?.aborted) throw new McpolyglotError('aborted', 'Aborted before execution');
    try {
      // db.transaction() rolls back if the callback throws.
      return db.transaction(() => {
        const startedAt = Date.now();
        const n = db.prepare(sql).run(...(params as unknown[])).changes as number;
        if (Date.now() - startedAt > opts.timeoutMs) {
          throw new McpolyglotError('timeout', `Write exceeded ${opts.timeoutMs}ms; rolled back`);
        }
        if (n > opts.maxRowsAffected) throw tooManyRows(n, opts.maxRowsAffected);
        return { rowsAffected: n };
      })();
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      if (code.startsWith('SQLITE_READONLY')) {
        throw new McpolyglotError('forbidden.read_only', (err as Error).message);
      }
      throw err;
    }
  }

  private requireDb(): BetterSqlite3Database {
    if (!this.db)
      throw new McpolyglotError('connector.not_initialized', 'SqliteDialect not connected');
    return this.db;
  }

  private resolvePath(): string {
    const v = this.fileOrUri;
    if (v.startsWith('sqlite://')) return v.replace(/^sqlite:\/\//, '');
    return v;
  }
}

function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadSqlite(): Promise<any> {
  try {
    const mod = (await import('better-sqlite3')) as unknown as {
      default?: unknown;
    };
    return mod.default ?? mod;
  } catch {
    throw new McpolyglotError(
      'connector.missing_dep',
      'The "better-sqlite3" package is required for the sqlite dialect. Install it with: pnpm add better-sqlite3',
    );
  }
}
