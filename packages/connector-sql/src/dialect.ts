import type { TableSchema } from '@mcpolyglot/core';
import { McpolyglotError } from '@mcpolyglot/core';

export interface SqlQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

export interface SqlDialect {
  readonly kind: 'postgres' | 'mysql' | 'mariadb' | 'sqlite';
  /** `writable: false` (the default) must open a connection the database itself keeps read-only. */
  connect(opts?: { writable?: boolean }): Promise<void>;
  close(): Promise<void>;
  ping(): Promise<{ ok: boolean; latencyMs: number; details?: string }>;
  listTables(): Promise<TableSchema[]>;
  /** Run a read-only query with timeout + row cap. Implementations MUST refuse writes. */
  runReadOnly(
    sql: string,
    params: ReadonlyArray<unknown>,
    opts: { rowCap: number; timeoutMs: number; signal?: AbortSignal },
  ): Promise<SqlQueryResult>;
  /**
   * Run one INSERT/UPDATE/DELETE in a transaction. If more than `maxRowsAffected` rows change,
   * roll back and throw `forbidden.policy`. On a read-only connection the database refuses it.
   */
  runWrite(
    sql: string,
    params: ReadonlyArray<unknown>,
    opts: { maxRowsAffected: number; timeoutMs: number; signal?: AbortSignal },
  ): Promise<{ rowsAffected: number }>;
}

export interface PoolOptions {
  max?: number;
  idleTimeoutMs?: number;
}

export function tooManyRows(n: number, max: number): McpolyglotError {
  return new McpolyglotError(
    'forbidden.policy',
    `Statement affected ${n} rows; policy maxWritesPerCall is ${max}. Rolled back.`,
    { rowsAffected: n, maxWritesPerCall: max },
  );
}
