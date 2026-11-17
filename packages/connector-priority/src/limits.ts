/**
 * Limits the Priority REST API documents for itself. Every number here is copied from the
 * official docs, with the page it came from; nothing is guessed. If Priority changes a value,
 * change it here and in docs/enterprise-connector-plan.md together.
 *
 * Source: https://prioritysoftware.github.io/restapi/ ("Request/Response Format",
 * "Priority Cloud - Fair Use Policy", "Login Lock").
 */
export const PRIORITY_DOCUMENTED_LIMITS = {
  /** "Each tenant is limited to a maximum of 100 API calls per minute." Per tenant, not per user. */
  callsPerMinutePerTenant: 100,
  /** "The system handles up to 10 requests at the same time, with another 5 in the queue." */
  maxInFlight: 10,
  maxQueued: 5,
  /** "5,000 requests per 300 s sliding window." */
  slidingWindow: { requests: 5_000, windowMs: 300_000 },
  /** "requests that take longer than 3 minutes to process will be dropped and generate an error." */
  upstreamTimeoutMs: 180_000,
  /** 25.1+: MAXAPILINES system constant, "default value 2,000 records". Before 25.1: MAXFORMLINES. */
  defaultMaxApiLines: 2_000,
  /** "Responses are capped at 350MB in size." */
  maxResponseBytes: 350 * 1024 * 1024,
  /** "Batch commands are limited to 100 operations in one batch call." No rollback. */
  maxBatchOperations: 100,
  /**
   * 26.1+: "After 3 failed login attempts within a 10-minute window, the account is locked" for
   * 30 minutes, and every attempt while locked gets HTTP 429. Applies to Basic, PAT and OAuth2.
   */
  loginLock: { failedAttempts: 3, windowMs: 600_000, lockMs: 1_800_000 },
} as const;

/** What a connector instance is configured to stay under. Defaults come from the table above. */
export interface UpstreamLimits {
  /** Calls per minute this source may make. Must be <= the tenant limit, shared by every agent. */
  callsPerMinute: number;
  /** Requests in flight to Priority at once, across all agents and tools of this source. */
  maxInFlight: number;
}

/**
 * Budget shared by every call this source makes, whichever agent or tool makes it.
 *
 * Why this is not the existing `RateLimiter` in `@mcpolyglot/security`: that one keys buckets by
 * `agent/session :: tool` (see `rate-limiter.ts`), so N agents x M tools each get their own
 * bucket. Priority's limit is per *tenant*. See decision D4 in docs/enterprise-connector-plan.md
 * for where this budget should live (core vs. connector) before implementing it.
 */
export interface UpstreamBudget {
  /**
   * Wait for (or refuse) a slot before a request goes to Priority. Resolves to a release
   * function the caller must call exactly once when the response is fully read or fails.
   *
   * TODO(ishay): implement. Decide: queue up to a bound and wait, or reject immediately with
   * `RateLimitError` (code `rate_limited`)? The pipeline already has a timeout racing the
   * handler, so a waiting acquire must honour `signal`.
   */
  acquire(signal: AbortSignal): Promise<() => void>;

  /**
   * Feed every upstream response back in, so the budget can react to what Priority says.
   *
   * TODO(ishay): implement.
   * - 429: Priority uses it both for fair-use throttling and for a login lock. Do not retry
   *   (ARCHITECTURE.md: no hidden retries); surface `rate_limited` to the agent.
   * - 401: a wrong PAT. Three of these in 10 minutes lock the Priority user for 30 minutes,
   *   so after the first 401 stop sending requests for this source until restart or config
   *   change. Decide how doctor reports this.
   * - Retry-After: the docs do not say whether Priority sends it. Check against the sandbox
   *   before relying on it.
   */
  onResponse(status: number, headers: Headers): void;
}
