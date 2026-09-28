import { describe, expect, it } from 'vitest';
import { Redactor } from '../redactor.js';

describe('Redactor', () => {
  it('redacts emails in text content', () => {
    const r = new Redactor();
    const out = r.apply('demo', {
      content: [{ type: 'text', text: 'reach me at alice@example.com please' }],
    });
    expect(out.redactionsApplied).toBe(1);
    expect((out.result.content[0] as { text: string }).text).toContain('[REDACTED:email]');
  });

  it('redacts JWT-shaped tokens', () => {
    const r = new Redactor();
    const jwt = 'eyJhbGciOi.eyJzdWIiOi.signaturepart';
    const out = r.apply('demo', {
      content: [{ type: 'text', text: `auth: ${jwt}` }],
    });
    expect(out.redactionsApplied).toBe(1);
    expect((out.result.content[0] as { text: string }).text).toContain('[REDACTED:jwt]');
  });

  it('drops denied columns from json content', () => {
    const r = new Redactor({ denyColumns: [{ path: 'users.password_hash' }] });
    const out = r.apply('demo', {
      content: [
        {
          type: 'json',
          data: { users: [{ id: 1, password_hash: 'hunter2', email: 'x@y.z' }] },
        },
      ],
    });
    const data = (out.result.content[0] as { data: { users: Array<Record<string, unknown>> } })
      .data;
    expect(data.users[0]).not.toHaveProperty('password_hash');
    expect(out.redactionsApplied).toBeGreaterThanOrEqual(1);
  });

  it('drops denied column names from a query result column list', () => {
    const r = new Redactor({ denyColumns: [{ path: 'users.password_hash' }] });
    const out = r.apply('demo', {
      content: [
        {
          type: 'json',
          data: { columns: ['id', 'password_hash'], rows: [{ id: 1, password_hash: 'hunter2' }] },
        },
      ],
    });
    const data = (out.result.content[0] as { data: { columns: string[] } }).data;
    expect(data.columns).toEqual(['id']);
  });

  it('honors custom regex rules', () => {
    const r = new Redactor({
      customRules: [{ name: 'iid', regex: /IID-\w+/g }],
    });
    const out = r.apply('demo', { content: [{ type: 'text', text: 'see IID-12345' }] });
    expect(out.redactionsApplied).toBe(1);
    expect((out.result.content[0] as { text: string }).text).toContain('[REDACTED:iid]');
  });
});
