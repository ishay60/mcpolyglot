import { describe, expect, it } from 'vitest';
import type { ToolExecCtx } from '@mcpolyglot/core';
import { MongoConnector } from '../connector.js';

const ctx = {
  limits: { rowCap: 10, timeoutMs: 1_000, maxBytes: 65_536 },
} as unknown as ToolExecCtx;

// The gate runs before any DB access, so no Mongo server is needed: an allowed pipeline
// gets as far as "not connected", a mutating one is refused first.
const aggregate = new MongoConnector({ id: 'm', url: 'mongodb://unused' })
  .listPrimitiveTools()
  .find((t) => t.name === 'm.aggregate')!;

describe('mongo aggregate write gate', () => {
  it.each(['$out', '$merge'])('rejects %s with forbidden.read_only', async (op) => {
    await expect(
      aggregate.handler({ collection: 'c', pipeline: [{ $match: {} }, { [op]: 'dst' }] }, ctx),
    ).rejects.toMatchObject({ code: 'forbidden.read_only' });
  });

  it('lets a read-only pipeline through to the DB layer', async () => {
    await expect(
      aggregate.handler({ collection: 'c', pipeline: [{ $match: {} }] }, ctx),
    ).rejects.not.toMatchObject({ code: 'forbidden.read_only' });
  });
});
