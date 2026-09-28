import { describe, expect, it } from 'vitest';
import { classify, isColumnDenied, PolicySchema, type Policy } from '../policy.js';

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

  // writes
  ['INSERT INTO orders (user_id, total_cents) VALUES (1, 100)', true, 'Allowed'],
  ['UPDATE orders SET total_cents = 1 WHERE id = 1', true, 'Allowed'],
  ['DELETE FROM orders WHERE id = 1', true, 'Allowed'],
  ["INSERT INTO users (email) VALUES ('x')", false, 'read-only'],
  ['INSERT INTO unlisted_table (id) VALUES (1)', false, 'read-only'], // default never grants write
  ['INSERT INTO orders (user_id) SELECT id FROM audit_log', false, 'not accessible'],
  ['UPDATE orders SET total_cents = 0', false, 'without a WHERE'],
  ['DELETE FROM orders', false, 'without a WHERE'],

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
