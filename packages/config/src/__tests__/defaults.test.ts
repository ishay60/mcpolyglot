import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../schema.js';

const source = { id: 's', kind: 'sqlite', url: 'x.db' };

describe('config safety defaults', () => {
  it('HTTP binds to loopback with bearer auth unless told otherwise', () => {
    const cfg = ConfigSchema.parse({ transport: { kind: 'http' }, sources: [source] });
    expect(cfg.transport).toMatchObject({ host: '127.0.0.1', auth: { type: 'bearer' } });
  });

  it('sources default to read scopes only, and limits to 200 rows / 10s / 256KiB', () => {
    const cfg = ConfigSchema.parse({ sources: [source] });
    expect(cfg.sources[0]!.scopes).toEqual(['schema:read', 'tables:read']);
    expect(cfg.sources[0]!.limits).toEqual({ rowCap: 200, timeoutMs: 10_000, maxBytes: 262_144 });
  });

  it('limits have hard maximums (10k rows, 60s)', () => {
    const bad = (limits: object) =>
      ConfigSchema.safeParse({ sources: [{ ...source, limits }] }).success;
    expect(bad({ rowCap: 10_001 })).toBe(false);
    expect(bad({ timeoutMs: 60_001 })).toBe(false);
  });
});
