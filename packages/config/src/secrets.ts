import { readFile } from 'node:fs/promises';
import { ConfigError } from '@mcpolyglot/core';

const REF_RE = /\$\{(env|file|keychain):([^}]+)\}/g;

/**
 * Resolve `${env:NAME}`, `${file:./path}`, and `${keychain:item}` references inside a string.
 * Throws ConfigError if a reference can't be resolved.
 */
export async function resolveSecrets(input: string): Promise<string> {
  const matches = [...input.matchAll(REF_RE)];
  if (matches.length === 0) return input;

  let out = '';
  let last = 0;
  for (const m of matches) {
    out += input.slice(last, m.index);
    const [, kind, target] = m;
    out += await resolveOne(kind!, target!);
    last = (m.index ?? 0) + m[0].length;
  }
  out += input.slice(last);
  return out;
}

async function resolveOne(kind: string, target: string): Promise<string> {
  switch (kind) {
    case 'env': {
      const v = process.env[target];
      if (v === undefined) throw new ConfigError(`Env var not set: ${target}`);
      return v;
    }
    case 'file': {
      try {
        return (await readFile(target, 'utf8')).trim();
      } catch (err) {
        throw new ConfigError(`Failed to read secret file ${target}: ${(err as Error).message}`);
      }
    }
    case 'keychain': {
      try {
        const keytar = await import('keytar').catch(() => null);
        if (!keytar) {
          throw new ConfigError('keytar is not installed; install it to use ${keychain:...} refs');
        }
        const v = await keytar.default.getPassword('mcpolyglot', target);
        if (v == null) throw new ConfigError(`Keychain item not found: mcpolyglot/${target}`);
        return v;
      } catch (err) {
        if (err instanceof ConfigError) throw err;
        throw new ConfigError(`Keychain lookup failed: ${(err as Error).message}`);
      }
    }
    default:
      throw new ConfigError(`Unknown secret-ref kind: ${kind}`);
  }
}

/**
 * Heuristic check: does this string look like a literal credential the user
 * should have wrapped in a `${env:...}` / `${file:...}` / `${keychain:...}` ref?
 * Used by `mcpolyglot doctor` to surface warnings.
 */
export function looksLikeLiteralCredential(value: string): boolean {
  // Not REF_RE.test(): a /g regex keeps lastIndex, which matchAll() in resolveSecrets inherits.
  if (new RegExp(REF_RE.source).test(value)) return false;

  // postgres://user:pass@host/db with a non-trivial password
  const dbUriMatch = value.match(/^[a-z][a-z0-9+]*:\/\/[^:@/\s]+:([^@/\s]+)@/i);
  if (dbUriMatch && dbUriMatch[1] && dbUriMatch[1].length > 4) return true;

  // bare bearer-token-shaped strings (long base64-ish)
  if (/^[A-Za-z0-9_\-]{32,}$/.test(value)) return true;

  return false;
}
