import { describe, expect, it } from 'vitest';
import { resolveSecrets, looksLikeLiteralCredential } from '../secrets.js';

describe('resolveSecrets', () => {
  it('returns the input unchanged when no refs are present', async () => {
    expect(await resolveSecrets('postgres://localhost/mydb')).toBe('postgres://localhost/mydb');
  });

  it('resolves ${env:NAME} from process.env', async () => {
    process.env.MCPOLYGLOT_TEST_VAR = 'hunter2';
    try {
      const out = await resolveSecrets('prefix-${env:MCPOLYGLOT_TEST_VAR}-suffix');
      expect(out).toBe('prefix-hunter2-suffix');
    } finally {
      delete process.env.MCPOLYGLOT_TEST_VAR;
    }
  });

  it('throws when an env ref is unset', async () => {
    delete process.env.MCPOLYGLOT_DEFINITELY_UNSET;
    await expect(resolveSecrets('${env:MCPOLYGLOT_DEFINITELY_UNSET}')).rejects.toThrow(/not set/);
  });
});

describe('looksLikeLiteralCredential', () => {
  it('flags a postgres URI with an inline password', () => {
    expect(looksLikeLiteralCredential('postgres://user:hunter2@localhost/db')).toBe(true);
  });

  it('does not flag a URI with a secret reference', () => {
    expect(looksLikeLiteralCredential('${env:DATABASE_URL}')).toBe(false);
  });

  it('does not break a later resolveSecrets of the same ref (doctor calls both)', async () => {
    process.env.MCPOLYGLOT_TEST_VAR = 'resolved';
    try {
      looksLikeLiteralCredential('${env:MCPOLYGLOT_TEST_VAR}');
      expect(await resolveSecrets('${env:MCPOLYGLOT_TEST_VAR}')).toBe('resolved');
    } finally {
      delete process.env.MCPOLYGLOT_TEST_VAR;
    }
  });

  it('does not flag a path-only sqlite URL', () => {
    expect(looksLikeLiteralCredential('./data.db')).toBe(false);
  });

  it('flags a long bearer-shaped token', () => {
    expect(looksLikeLiteralCredential('A'.repeat(40))).toBe(true);
  });
});
