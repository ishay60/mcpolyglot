import type { Scope, ToolResult, SecurityHooks } from '@mcpolyglot/core';
import { ScopeGuard } from './scope-guard.js';
import { Redactor, type RedactionRule, type ColumnDenyEntry } from './redactor.js';
import { RateLimiter, type RateLimitOptions } from './rate-limiter.js';
import { AuditLogger, type AuditLoggerOptions } from './audit.js';
import { wrapUntrusted, enforceSize, type WrapMode } from './wrap.js';

/** Options for `defaultSecurityHooks`. All fields are optional — sensible defaults apply. */
export interface DefaultHookOptions {
  rateLimit?: RateLimitOptions;
  audit?: AuditLoggerOptions;
  /** Extra redaction rules and per-column deny lists, on top of the built-ins. */
  redactor?: { customRules?: RedactionRule[]; denyColumns?: ColumnDenyEntry[] };
  /** How aggressively to wrap untrusted result data. Defaults to `'strict'`. */
  wrapMode?: WrapMode;
}

/**
 * Construct the standard set of `SecurityHooks` — scope guard, rate limiter, redactor,
 * audit logger, and the untrusted-data wrapper. Pass the result to `McpolyglotServer`'s
 * `security.hooks`.
 *
 * @example
 * ```ts
 * import { defaultSecurityHooks } from '@mcpolyglot/security';
 *
 * const hooks = defaultSecurityHooks({
 *   rateLimit: { defaultPerMinute: 60, maxConcurrent: 8 },
 *   redactor: { denyColumns: [{ table: 'public.users', column: 'password_hash' }] },
 * });
 * ```
 */
export function defaultSecurityHooks(opts: DefaultHookOptions = {}): SecurityHooks {
  const guard = new ScopeGuard();
  const limiter = new RateLimiter(opts.rateLimit);
  const redactor = new Redactor(opts.redactor);
  const audit = new AuditLogger(opts.audit);
  const wrapMode: WrapMode = opts.wrapMode ?? 'strict';

  return {
    checkScopes(toolName: string, required: readonly Scope[], granted: ReadonlySet<Scope>) {
      guard.check(toolName, required, granted);
    },
    checkRateLimit(toolName: string, sessionId: string) {
      return limiter.check(toolName, sessionId);
    },
    redact(toolName: string, result: ToolResult) {
      return redactor.apply(toolName, result);
    },
    enforceSize(toolName: string, result: ToolResult, maxBytes: number) {
      return enforceSize(toolName, result, maxBytes);
    },
    wrapUntrusted(result: ToolResult) {
      return wrapUntrusted(result, wrapMode);
    },
    async audit(entry) {
      await audit.append(entry as unknown as Record<string, unknown>);
    },
  };
}

/**
 * Compose multiple `SecurityHooks` objects into one. Each phase runs through the
 * provided hooks in order — useful for adding custom audit sinks or extra redaction
 * passes alongside the defaults.
 */
export function composeHooks(...hooks: SecurityHooks[]): SecurityHooks {
  return {
    checkScopes(toolName, required, granted) {
      for (const h of hooks) h.checkScopes(toolName, required, granted);
    },
    async checkRateLimit(toolName, sessionId) {
      const releases: Array<() => void> = [];
      try {
        for (const h of hooks) {
          const r = await h.checkRateLimit(toolName, sessionId);
          if (r) releases.push(r);
        }
      } catch (err) {
        for (const r of releases) r();
        throw err;
      }
      return () => releases.forEach((r) => r());
    },
    redact(toolName, result) {
      let acc = result;
      let count = 0;
      for (const h of hooks) {
        const r = h.redact(toolName, acc);
        acc = r.result;
        count += r.redactionsApplied;
      }
      return { result: acc, redactionsApplied: count };
    },
    enforceSize(toolName, result, maxBytes) {
      let acc = result;
      for (const h of hooks) acc = h.enforceSize(toolName, acc, maxBytes);
      return acc;
    },
    wrapUntrusted(result) {
      let acc = result;
      for (const h of hooks) acc = h.wrapUntrusted(acc);
      return acc;
    },
    async audit(entry) {
      for (const h of hooks) await h.audit(entry);
    },
  };
}
