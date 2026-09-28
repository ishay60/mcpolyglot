import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TableSchema } from '@mcpolyglot/core';
import { PolicySchema, SqliteDialect } from '@mcpolyglot/connector-sql';
import { generatePolicy, initCommand } from '../commands/init.js';
import { checkPolicy } from '../commands/doctor.js';

let canRun = true;
try {
  await import('better-sqlite3');
} catch {
  canRun = false;
}
const d = canRun ? describe : describe.skip;

d('init <url> / doctor policy checks against SQLite', () => {
  let dir: string;
  let dbPath: string;
  let tables: TableSchema[];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcpolyglot-init-'));
    dbPath = join(dir, 'app.db');
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, ssn TEXT, password_hash TEXT);
      CREATE TABLE accounts (id INTEGER PRIMARY KEY, customer_id INTEGER, api_key TEXT, balance INTEGER);
      CREATE TABLE transactions (id INTEGER PRIMARY KEY, account_id INTEGER, amount INTEGER);
    `);
    db.close();
    const dialect = new SqliteDialect(dbPath);
    await dialect.connect();
    tables = await dialect.listTables();
    await dialect.close();
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('generates an all-read policy with defaultAccess none and heuristic denies', () => {
    const policy = PolicySchema.parse(generatePolicy(tables));
    expect(policy.defaultAccess).toBe('none');
    expect(policy.tables).toEqual({ accounts: 'read', customers: 'read', transactions: 'read' });
    expect(policy.denyColumns.sort()).toEqual([
      'accounts.api_key',
      'customers.password_hash',
      'customers.ssn',
    ]);
  });

  it('writes the policy into mcpolyglot.config.ts, marked as suggestions', async () => {
    await initCommand({ cwd: dir, url: dbPath, id: 'sqlite.app' });
    const text = readFileSync(join(dir, 'mcpolyglot.config.ts'), 'utf8');
    expect(text).toContain(`defaultAccess: 'none'`);
    expect(text).toContain(`"transactions": 'read'`);
    expect(text).not.toContain(`: 'write'`);
    expect(text).toMatch(/Suggested from column names[\s\S]*"customers.ssn"/);
    // Only a type import: the file must load under npx with no @mcpolyglot/config installed.
    expect(text).toMatch(/^import type \{ McpolyglotConfig \} from '@mcpolyglot\/config';/m);
    expect(text).not.toMatch(/^import \{/m);
    await expect(initCommand({ cwd: dir, url: dbPath })).rejects.toThrow(/already exists/);
  });

  it('doctor flags policy keys and denyColumns that are not in the schema', () => {
    const r = checkPolicy(
      {
        defaultAccess: 'none',
        tables: { customers: 'read', accounts: 'write', ledger: 'read' },
        denyColumns: ['customers.ssn', 'customers.pin', '*.nope'],
      },
      tables,
    );
    expect(r.problems).toEqual([
      'policy.tables names "ledger", which is not in the schema',
      'denyColumns has "customers.pin", which matches no column in the schema',
      'denyColumns has "*.nope", which matches no column in the schema',
    ]);
    expect(r.readable).toEqual(['customers']);
    expect(r.writable).toEqual(['accounts']);
    expect(r.hidden).toEqual(['transactions']);
    expect(r.hiddenColumns).toEqual(['customers.ssn']);
  });

  it('doctor reports a clean generated policy with no problems', () => {
    expect(checkPolicy(generatePolicy(tables), tables).problems).toEqual([]);
  });
});
