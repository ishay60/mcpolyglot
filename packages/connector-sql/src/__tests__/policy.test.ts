import { describe, expect, it } from 'vitest';
import { classify, isColumnDenied, narrowPolicy, PolicySchema, type Policy } from '../policy.js';
import { stripDeniedKeys } from '../connector.js';

const policy: Policy = PolicySchema.parse({
  tables: { users: 'read', orders: 'write', 'public.secrets': 'none', audit_log: 'none' },
  defaultAccess: 'read',
  denyColumns: ['users.password_hash', '*.ssn'],
});

// [sql, allow, reason substring]
const cases: Array<[string, boolean, string]> = [
  // reads
  ['SELECT email FROM users', true, 'Allowed'],
  ['SELECT u.email FROM users u JOIN orders o ON o.user_id = u.id', true, 'Allowed'],
  ['SELECT count(*) FROM users', true, 'Allowed'],
  ['SELECT id, total_cents FROM orders', true, 'Allowed'],
  // `*.column` rules can't know which tables have the column, so any SELECT * is denied.
  ['SELECT * FROM orders', false, '*.ssn'],
  ['SELECT id FROM unlisted_table', true, 'Allowed'],

  // table access
  ['SELECT * FROM audit_log', false, 'not accessible'],
  ['SELECT * FROM public.secrets', false, 'not accessible'],
  ['SELECT * FROM secrets', false, 'not accessible'], // unqualified can't dodge schema rule
  ['SELECT id FROM users WHERE id IN (SELECT user_id FROM audit_log)', false, 'not accessible'],

  // column denies
  ['SELECT password_hash FROM users', false, 'users.password_hash'],
  ['SELECT u.password_hash AS p FROM users u', false, 'users.password_hash'],
  ['SELECT email FROM users WHERE password_hash = $1', false, 'users.password_hash'],
  ['SELECT (SELECT password_hash FROM users LIMIT 1)', false, 'users.password_hash'],
  ['SELECT * FROM users', false, 'SELECT *'],
  ['SELECT u.* FROM users u', false, 'SELECT *'],
  ['SELECT ssn FROM anything', false, '*.ssn'],
  ['SELECT PASSWORD_HASH FROM Users', false, 'password_hash'],
  // whole-row references return every column, denied ones included, inside one value
  ['SELECT u FROM users u', false, 'Whole-row'],
  ['SELECT users FROM users', false, 'Whole-row'],
  ['SELECT to_jsonb(u) FROM users u', false, 'Whole-row'],
  ['SELECT json_agg(u) FROM users u', false, 'Whole-row'],
  ['SELECT u::text FROM users u', false, 'Whole-row'],
  ['SELECT row_to_json(users) FROM users', false, 'Whole-row'],
  ['SELECT o FROM orders o', false, '*.ssn'], // `*.col` rule: any whole row could carry it
  ['SELECT o.id FROM orders o JOIN users u ON u.id = o.user_id', true, 'Allowed'],

  // writes
  ['INSERT INTO orders (user_id, total_cents) VALUES (1, 100)', true, 'Allowed'],
  ['UPDATE orders SET total_cents = 1 WHERE id = 1', true, 'Allowed'],
  ['DELETE FROM orders WHERE id = 1', true, 'Allowed'],
  ["INSERT INTO users (email) VALUES ('x')", false, 'read-only'],
  ['INSERT INTO unlisted_table (id) VALUES (1)', false, 'read-only'], // default never grants write
  ['INSERT INTO orders (user_id) SELECT id FROM audit_log', false, 'not accessible'],
  ['UPDATE orders SET total_cents = 0', false, 'without a WHERE'],
  ['DELETE FROM orders', false, 'without a WHERE'],
  ['UPDATE orders SET total_cents = 0 WHERE 1=1', false, 'names no column'],
  ['DELETE FROM orders WHERE true', false, 'names no column'],

  // server access through functions / INTO / system catalogs
  ["SELECT pg_read_file('/etc/passwd')", false, 'pg_read_file'],
  ["SELECT PG_READ_FILE('/etc/passwd')", false, 'pg_read_file'],
  ["SELECT pg_catalog.pg_read_file('/etc/passwd')", false, 'pg_read_file'],
  ["SELECT * FROM pg_ls_dir('.')", false, 'pg_ls_dir'],
  ["SELECT email FROM users WHERE id = (SELECT lo_import('/etc/passwd'))", false, 'lo_import'],
  ["SELECT dblink_connect('host=x')", false, 'dblink_connect'],
  ['SELECT pg_sleep(10)', false, 'pg_sleep'],
  ['SELECT * FROM information_schema.tables', false, 'System table'],
  ['SELECT * FROM pg_catalog.pg_shadow', false, 'System table'],
  ['SELECT * FROM pg_shadow', false, 'System table'],

  // DDL / admin / multi-statement / garbage
  ['DROP TABLE orders', false, 'always blocked'],
  ['CREATE TABLE x (id int)', false, 'always blocked'],
  ['ALTER TABLE orders ADD COLUMN y int', false, 'always blocked'],
  ['TRUNCATE orders', false, 'always blocked'],
  ['GRANT ALL ON orders TO public', false, ''],
  ['SELECT 1; DROP TABLE orders', false, 'one statement'],
  ['WITH x AS (DELETE FROM orders RETURNING id) SELECT * FROM x', false, ''],
  ['SELEC oops', false, 'Could not parse'],
];

describe('classify (postgres)', () => {
  it.each(cases)('%s → allow=%s', (sql, allow, reason) => {
    const d = classify(sql, policy, 'postgres');
    expect(d.allow, d.reason).toBe(allow);
    expect(d.reason).toContain(reason);
  });
});

describe('classify (mysql): file access', () => {
  it.each([
    ["SELECT LOAD_FILE('/etc/passwd')", 'load_file'],
    ["SELECT * FROM orders INTO OUTFILE '/tmp/x'", 'INTO'],
    ["SELECT id FROM orders INTO DUMPFILE '/tmp/x'", 'INTO'],
    ['SELECT SLEEP(10)', 'sleep'],
    ['SELECT * FROM mysql.user', 'System table'],
  ])('%s denied', (sql, reason) => {
    const d = classify(sql, policy, 'mysql');
    expect(d.allow, d.reason).toBe(false);
    expect(d.reason).toContain(reason);
  });

  it('a system table can be exposed by listing it explicitly', () => {
    const p = PolicySchema.parse({ tables: { 'information_schema.tables': 'read' } });
    expect(classify('SELECT * FROM information_schema.tables', p, 'mysql').allow).toBe(true);
    expect(classify('SELECT * FROM information_schema.columns', p, 'mysql').allow).toBe(false);
  });
});

describe('classify (sqlite): extensions', () => {
  it('denies load_extension and sqlite_master', () => {
    expect(classify("SELECT load_extension('x')", policy, 'sqlite').allow).toBe(false);
    expect(classify('SELECT * FROM sqlite_master', policy, 'sqlite').allow).toBe(false);
  });
});

describe('classify across dialects', () => {
  it.each(['mysql', 'sqlite'] as const)('%s: denies column + DDL, allows plain read', (dialect) => {
    expect(classify('SELECT email FROM users', policy, dialect).allow).toBe(true);
    expect(classify('SELECT password_hash FROM users', policy, dialect).allow).toBe(false);
    expect(classify('DROP TABLE users', policy, dialect).allow).toBe(false);
  });
});

describe('policy defaults', () => {
  it('empty policy: reads allowed, every write denied', () => {
    const p = PolicySchema.parse({});
    expect(classify('SELECT * FROM anything', p, 'postgres').allow).toBe(true);
    expect(classify('DELETE FROM anything WHERE id = 1', p, 'postgres').allow).toBe(false);
  });

  it('defaultAccess cannot be write', () => {
    expect(() => PolicySchema.parse({ defaultAccess: 'write' })).toThrow();
  });

  it('defaultAccess none hides unlisted tables', () => {
    const p = PolicySchema.parse({ defaultAccess: 'none', tables: { users: 'read' } });
    expect(classify('SELECT id FROM users', p, 'postgres').allow).toBe(true);
    expect(classify('SELECT id FROM other', p, 'postgres').allow).toBe(false);
  });

  it('most restrictive matching key wins', () => {
    const p = PolicySchema.parse({ tables: { users: 'write', 'public.users': 'none' } });
    expect(classify('SELECT id FROM public.users', p, 'postgres').allow).toBe(false);
  });

  it('isColumnDenied', () => {
    expect(isColumnDenied(policy, 'public.users', 'password_hash')).toBe(true);
    expect(isColumnDenied(policy, 'users', 'email')).toBe(false);
    expect(isColumnDenied(policy, 'whatever', 'SSN')).toBe(true);
  });
});

describe('narrowPolicy', () => {
  const base = PolicySchema.parse({
    tables: { 'public.users': 'none', orders: 'write' },
    defaultAccess: 'none',
    denyColumns: ['orders.card'],
    maxRows: 50,
  });
  const wider = PolicySchema.parse({
    tables: { users: 'write', orders: 'write', items: 'write' },
    defaultAccess: 'read',
    denyColumns: ['orders.note'],
    maxRows: 500,
    maxWritesPerCall: 10,
  });
  const n = narrowPolicy(base, wider);

  it('never widens table access, even via a differently-qualified key', () => {
    expect(classify('SELECT id FROM users', n, 'postgres').allow).toBe(false);
    expect(classify('SELECT id FROM public.users', n, 'postgres').allow).toBe(false);
    expect(classify('SELECT id FROM items', n, 'postgres').allow).toBe(false); // base default none
    expect(n.defaultAccess).toBe('none');
  });

  it('keeps grants both sides agree on', () => {
    expect(classify('DELETE FROM orders WHERE id = 1', n, 'postgres').allow).toBe(true);
  });

  it('unions deny lists and takes the smaller caps', () => {
    expect(n.denyColumns.sort()).toEqual(['orders.card', 'orders.note']);
    expect(n.maxRows).toBe(50);
    expect(n.maxWritesPerCall).toBe(1);
  });

  it('can narrow further', () => {
    const tighter = narrowPolicy(base, PolicySchema.parse({ tables: { orders: 'read' } }));
    expect(classify('DELETE FROM orders WHERE id = 1', tighter, 'postgres').allow).toBe(false);
    expect(classify('SELECT id FROM orders', tighter, 'postgres').allow).toBe(true);
  });
});

describe('stripDeniedKeys (output-side filter)', () => {
  const denied = new Set(['password_hash', 'ssn']);
  it('drops denied keys at any depth, in objects and arrays', () => {
    const rows = [
      { id: 1, password_hash: 'x', profile: { ssn: '1', name: 'a' } },
      { agg: [{ id: 2, PASSWORD_HASH: 'y' }, { id: 3 }] },
    ];
    expect(stripDeniedKeys(rows, denied)).toEqual([
      { id: 1, profile: { name: 'a' } },
      { agg: [{ id: 2 }, { id: 3 }] },
    ]);
  });
  it('leaves scalars, nulls, and class instances alone', () => {
    const d = new Date(0);
    expect(stripDeniedKeys([{ at: d, n: null, s: 'ssn' }], denied)).toEqual([
      { at: d, n: null, s: 'ssn' },
    ]);
  });
});
