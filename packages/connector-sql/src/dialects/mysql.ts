import sqlParser from 'node-sql-parser';
import type { ColumnSchema, TableSchema } from '@mcpolyglot/core';
import { McpolyglotError } from '@mcpolyglot/core';
import { tooManyRows, type PoolOptions, type SqlDialect, type SqlQueryResult } from '../dialect.js';

const { Parser } = sqlParser;

type MysqlPool = import('mysql2/promise').Pool;

type CoreConnection = { query(sql: string, cb: (err: unknown) => void): void; destroy(): void };

const READ_OPS = new Set(['select', 'show', 'describe', 'desc', 'explain', 'with']);

export class MysqlDialect implements SqlDialect {
  readonly kind = 'mysql' as const;
  private pool?: MysqlPool;
  private readonly parser = new Parser();

  constructor(
    private readonly connectionString: string,
    private readonly poolOpts: PoolOptions = {},
  ) {}

  async connect({ writable = false }: { writable?: boolean } = {}): Promise<void> {
    const mysql = await loadMysql();
    this.pool = mysql.createPool({
      uri: this.connectionString,
      connectionLimit: this.poolOpts.max ?? 4,
      ...(this.poolOpts.idleTimeoutMs ? { idleTimeout: this.poolOpts.idleTimeoutMs } : {}),
      enableKeepAlive: true,
    });
    if (!writable) {
      // Session-wide: every later transaction on this connection is read-only. If the SET
      // fails, drop the connection rather than hand out a writable one.
      this.pool.on('connection', (promiseTyped) => {
        // The event hands over the callback-style core connection despite the promise typings.
        const conn = promiseTyped as unknown as CoreConnection;
        conn.query('SET SESSION TRANSACTION READ ONLY', (err: unknown) => {
          if (err) conn.destroy();
        });
      });
    }
    const c = await this.pool.getConnection();
    try {
      await c.query('SELECT 1');
    } finally {
      c.release();
    }
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = undefined;
  }

  async ping(): Promise<{ ok: boolean; latencyMs: number; details?: string }> {
    const t0 = Date.now();
    try {
      const c = await this.requirePool().getConnection();
      try {
        await c.query('SELECT 1');
        return { ok: true, latencyMs: Date.now() - t0 };
      } finally {
        c.release();
      }
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - t0, details: (err as Error).message };
    }
  }

  async auditPrivileges(): Promise<string[]> {
    const c = await this.requirePool().getConnection();
    try {
      const [rows] = (await c.query('SHOW GRANTS FOR CURRENT_USER()')) as [
        Array<Record<string, unknown>>,
        unknown,
      ];
      const grants = rows.map((r) => String(Object.values(r)[0] ?? '')).join('\n');
      const problems: string[] = [];
      if (/\bALL PRIVILEGES\b/i.test(grants))
        problems.push('database user has ALL PRIVILEGES; policy cannot be enforced');
      if (/\bSUPER\b/i.test(grants)) problems.push('database user has SUPER');
      if (/\bFILE\b/i.test(grants))
        problems.push('database user has FILE (LOAD_FILE, SELECT ... INTO OUTFILE)');
      return problems;
    } finally {
      c.release();
    }
  }

  async listTables(): Promise<TableSchema[]> {
    const c = await this.requirePool().getConnection();
    try {
      const [rows] = (await c.query(
        `SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS \`name\`
         FROM information_schema.tables
         WHERE TABLE_SCHEMA NOT IN ('mysql','information_schema','performance_schema','sys')
         ORDER BY TABLE_SCHEMA, TABLE_NAME`,
      )) as [Array<{ schema: string; name: string }>, unknown];

      const tables: TableSchema[] = [];
      for (const row of rows) {
        const [colRows] = (await c.query(
          `SELECT COLUMN_NAME AS \`name\`, COLUMN_TYPE AS \`type\`,
                  IS_NULLABLE AS \`isNullable\`, COLUMN_KEY AS \`columnKey\`
           FROM information_schema.columns
           WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
           ORDER BY ORDINAL_POSITION`,
          [row.schema, row.name],
        )) as [
          Array<{ name: string; type: string; isNullable: 'YES' | 'NO'; columnKey: string }>,
          unknown,
        ];
        const columns: ColumnSchema[] = colRows.map((cr) => ({
          name: cr.name,
          type: cr.type,
          nullable: cr.isNullable === 'YES',
          primaryKey: cr.columnKey === 'PRI',
        }));
        tables.push({ schema: row.schema, name: row.name, columns });
      }
      return tables;
    } finally {
      c.release();
    }
  }

  async runReadOnly(
    sql: string,
    params: ReadonlyArray<unknown>,
    opts: { rowCap: number; timeoutMs: number; signal?: AbortSignal },
  ): Promise<SqlQueryResult> {
    // 1. AST gate: parse with mysql grammar; refuse anything that isn't a read.
    this.assertReadOnlyOrThrow(sql);

    const c = await this.requirePool().getConnection();
    try {
      // 2. Transaction read-only (not SESSION: a writable pool reuses this connection for writes).
      await c.query('START TRANSACTION READ ONLY');
      try {
        const [rows, fields] = (await c.query({
          sql: this.injectMaxExecutionTime(sql, opts.timeoutMs),
          values: params as unknown[],
          rowsAsArray: false,
        })) as [Array<Record<string, unknown>>, Array<{ name: string }>];

        const columns = fields?.map((f) => f.name) ?? (rows[0] ? Object.keys(rows[0]) : []);
        const truncated = rows.length > opts.rowCap;
        const sliced = truncated ? rows.slice(0, opts.rowCap) : rows;
        return { columns, rows: sliced, rowCount: sliced.length, truncated };
      } finally {
        await c.query('ROLLBACK').catch(() => {});
      }
    } finally {
      c.release();
    }
  }

  async runWrite(
    sql: string,
    params: ReadonlyArray<unknown>,
    opts: { maxRowsAffected: number; timeoutMs: number; signal?: AbortSignal },
  ): Promise<{ rowsAffected: number }> {
    const c = await this.requirePool().getConnection();
    try {
      await c.query('START TRANSACTION');
      // MAX_EXECUTION_TIME only covers SELECT, so DML gets mysql2's client-side timeout.
      const [res] = (await c.query({
        sql,
        values: params as unknown[],
        timeout: opts.timeoutMs,
      })) as unknown as [{ affectedRows: number }];
      const n = res.affectedRows;
      if (n > opts.maxRowsAffected) throw tooManyRows(n, opts.maxRowsAffected);
      await c.query('COMMIT');
      return { rowsAffected: n };
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      // 1792 = ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION
      if ((err as { errno?: number }).errno === 1792) {
        throw new McpolyglotError('forbidden.read_only', (err as Error).message);
      }
      throw err;
    } finally {
      c.release();
    }
  }

  /**
   * MySQL `SET TRANSACTION READ ONLY` is partially honored; some functions
   * (e.g., `SLEEP`, write-time UDFs) bypass it. We pre-screen with a parser
   * that rejects any non-read top-level statement.
   */
  private assertReadOnlyOrThrow(sql: string): void {
    let asts: unknown;
    try {
      asts = this.parser.astify(sql, { database: 'mysql' });
    } catch (err) {
      throw new McpolyglotError(
        'forbidden.read_only',
        `Could not parse SQL: ${(err as Error).message}`,
      );
    }
    const list = Array.isArray(asts) ? asts : [asts];
    for (const node of list) {
      const type = ((node as { type?: string })?.type ?? '').toLowerCase();
      if (!READ_OPS.has(type)) {
        throw new McpolyglotError(
          'forbidden.read_only',
          `Statement is not read-only (got "${type || 'unknown'}")`,
        );
      }
    }
  }

  /** Inject `MAX_EXECUTION_TIME` hint on SELECTs so the server cancels long queries. */
  private injectMaxExecutionTime(sql: string, timeoutMs: number): string {
    const trimmed = sql.replace(/^\s+/, '');
    if (/^select\s/i.test(trimmed) && !/MAX_EXECUTION_TIME/i.test(trimmed)) {
      return trimmed.replace(/^select\s/i, `SELECT /*+ MAX_EXECUTION_TIME(${timeoutMs}) */ `);
    }
    return sql;
  }

  private requirePool(): MysqlPool {
    if (!this.pool)
      throw new McpolyglotError('connector.not_initialized', 'MysqlDialect not connected');
    return this.pool;
  }
}

async function loadMysql(): Promise<typeof import('mysql2/promise')> {
  try {
    return await import('mysql2/promise');
  } catch {
    throw new McpolyglotError(
      'connector.missing_dep',
      'The "mysql2" package is required for the mysql dialect. Install it with: pnpm add mysql2',
    );
  }
}
