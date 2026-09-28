import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../rate-limiter.js';

describe('RateLimiter', () => {
  it('allows up to perMinute calls then rejects', async () => {
    const rl = new RateLimiter({ perMinute: 3, maxConcurrent: 10 });
    await rl.check('demo.query', 'session-1');
    await rl.check('demo.query', 'session-1');
    await rl.check('demo.query', 'session-1');
    await expect(rl.check('demo.query', 'session-1')).rejects.toThrow(/Rate limit/);
  });

  it('uses independent buckets per session and tool', async () => {
    const rl = new RateLimiter({ perMinute: 2, maxConcurrent: 10 });
    await rl.check('demo.query', 'session-a');
    await rl.check('demo.query', 'session-a');
    // Different session: fresh bucket
    await expect(rl.check('demo.query', 'session-b')).resolves.not.toThrow();
    // Different tool, same session: fresh bucket
    await expect(rl.check('demo.list_tables', 'session-a')).resolves.not.toThrow();
  });
});

describe('RateLimiter concurrency', () => {
  it('caps concurrent calls, and frees the slot when a call finishes', async () => {
    const rl = new RateLimiter({ perMinute: 100, maxConcurrent: 2 });
    const a = await rl.check('t', 's');
    const b = await rl.check('t', 's');
    await expect(rl.check('t', 's')).rejects.toMatchObject({ code: 'rate_limited' });
    a();
    const c = await rl.check('t', 's');
    b();
    c();
  });

  it('sequential calls never hit the concurrency cap', async () => {
    const rl = new RateLimiter({ perMinute: 100, maxConcurrent: 1 });
    for (let i = 0; i < 10; i++) (await rl.check('t', 's'))();
  });

  it('release is idempotent', async () => {
    const rl = new RateLimiter({ perMinute: 100, maxConcurrent: 1 });
    const r = await rl.check('t', 's');
    r();
    r();
    const r2 = await rl.check('t', 's');
    await expect(rl.check('t', 's')).rejects.toMatchObject({ code: 'rate_limited' });
    r2();
  });
});
