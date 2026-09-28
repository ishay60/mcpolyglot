import type { TableSchema } from '@mcpolyglot/core';
import { McpolyglotError } from '@mcpolyglot/core';
import { tooManyRows, type PoolOptions, type SqlDialect, type SqlQueryResult } from '../dialect.js';

export class PostgresDialect implements SqlDialect {
  readonly kind = 'postgres' as const;
  private pool?: import('pg').Pool;

  constructor(
    private readonly connectionString: string,
    private readonly poolOpts: PoolOptions = {},
  ) {}

  async connect({ writable = false }: { writable?: boolean } = {}): Promise<void> {
    const { Pool } = await loadPg();
    this.pool = new Pool({
      connectionString: this.connectionString,
      max: this.poolOpts.max ?? 4,
      idleTimeoutMillis: this.poolOpts.idleTimeoutMs ?? 30_000,
      application_name: 'mcpolyglot',
      // Every transaction on a read-only pool is read-only unless explicitly overridden.
      ...(writable ? {} : { options: '-c default_transaction_read_only=on' }),
    });
    // probe
    const c = await this.pool.connect();
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
      const c = await this.requirePool().connect();
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

  async listTables(): Promise<TableSchema[]> {
    const c = await this.requirePool().connect();
    try {
      const sql = `
        SELECT
          n.nspname AS schema,
          c.relname AS table,
          jsonb_agg(jsonb_build_object(
            'name', a.attname,
            'type', format_type(a.atttypid, a.atttypmod),
            'nullable', NOT a.attnotnull,
            'primaryKey', COALESCE(pk.is_pk, false)
          ) ORDER BY a.attnum) AS columns
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        LEFT JOIN (
          SELECT i.indrelid, k.attnum, true AS is_pk
          FROM pg_index i
          JOIN pg_attribute k ON k.attrelid = i.indrelid AND k.attnum = ANY(i.indkey)
          WHERE i.indisprimary
        ) pk ON pk.indrelid = c.oid AND pk.attnum = a.attnum
        WHERE c.relkind IN ('r','p','v','m')
          AND n.nspname NOT IN ('pg_catalog','information_schema')
        GROUP BY n.nspname, c.relname
        ORDER BY n.nspname, c.relname;
      `;
      const res = await c.query<{
        schema: string;
        table: string;
        columns: Array<{ name: string; type: string; nullable: boolean; primaryKey?: boolean }>;
      }>(sql);
      return res.rows.map((r) => ({
        schema: r.schema,
        name: r.table,
        columns: r.columns,
      }));
    } finally {
      c.release();
    }
  }

  async runReadOnly(
    sql: string,
    params: ReadonlyArray<unknown>,
    opts: { rowCap: number; timeoutMs: number; signal?: AbortSignal },
  ): Promise<SqlQueryResult> {
    const c = await this.requirePool().connect();
    try {
      await c.query('BEGIN READ ONLY');
      await c.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(opts.timeoutMs))}`);
      const onAbort = () => {
        // best-effort cancellation
        c.query('SELECT pg_cancel_backend(pg_backend_pid())').catch(() => {});
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      try {
        const res = await c.query({ text: sql, values: params as unknown[], rowMode: 'array' });
        const fields = res.fields.map((f) => f.name);
        const rawRows = res.rows as unknown[][];
        const truncated = rawRows.length > opts.rowCap;
        const rows = (truncated ? rawRows.slice(0, opts.rowCap) : rawRows).map((row) => {
          const obj: Record<string, unknown> = {};
          fields.forEach((f, i) => {
            obj[f] = row[i];
          });
          return obj;
        });
        return { columns: fields, rows, rowCount: rows.length, truncated };
      } catch (err) {
        throw mapReadOnly(err);
      } finally {
        opts.signal?.removeEventListener('abort', onAbort);
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
    const c = await this.requirePool().connect();
    const onAbort = () => {
      c.query('SELECT pg_cancel_backend(pg_backend_pid())').catch(() => {});
    };
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(opts.timeoutMs))}`);
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      const res = await c.query({ text: sql, values: params as unknown[] });
      const n = res.rowCount ?? 0;
      if (n > opts.maxRowsAffected) throw tooManyRows(n, opts.maxRowsAffected);
      await c.query('COMMIT');
      return { rowsAffected: n };
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw mapReadOnly(err);
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      c.release();
    }
  }

  private requirePool(): import('pg').Pool {
    if (!this.pool)
      throw new McpolyglotError('connector.not_initialized', 'PostgresDialect not connected');
    return this.pool;
  }
}

// 25006 = read_only_sql_transaction: the DB-level guard caught a write.
function mapReadOnly(err: unknown): unknown {
  if ((err as { code?: string }).code === '25006') {
    return new McpolyglotError('forbidden.read_only', (err as Error).message);
  }
  return err;
}

async function loadPg(): Promise<typeof import('pg')> {
  try {
    return await import('pg');
  } catch {
    throw new McpolyglotError(
      'connector.missing_dep',
      'The "pg" package is required for the postgres dialect. Install it with: pnpm add pg',
    );
  }
}
