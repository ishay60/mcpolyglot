import type { ToolResult, SecurityHooks } from '@mcpolyglot/core';
import { checkScopes } from './scope-guard.js';
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
  const limiter = new RateLimiter(opts.rateLimit);
  const redactor = new Redactor(opts.redactor);
  const audit = new AuditLogger(opts.audit);
  const wrapMode: WrapMode = opts.wrapMode ?? 'strict';

  return {
    checkScopes,
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
