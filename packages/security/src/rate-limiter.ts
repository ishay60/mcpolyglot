import { RateLimitError } from '@mcpolyglot/core';

export interface RateLimitOptions {
  perMinute?: number;
  maxConcurrent?: number;
}

interface BucketState {
  tokens: number;
  lastRefillMs: number;
  inFlight: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, BucketState>();
  private readonly perMinute: number;
  private readonly maxConcurrent: number;

  constructor(opts: RateLimitOptions = {}) {
    this.perMinute = opts.perMinute ?? 30;
    this.maxConcurrent = opts.maxConcurrent ?? 5;
  }

  /** Take a token and a concurrency slot. Call the returned function when the call ends. */
  async check(toolName: string, sessionId: string): Promise<() => void> {
    const key = `${sessionId}::${toolName}`;
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.perMinute, lastRefillMs: now, inFlight: 0 };
      this.buckets.set(key, bucket);
    }
    const elapsed = (now - bucket.lastRefillMs) / 60_000;
    bucket.tokens = Math.min(this.perMinute, bucket.tokens + elapsed * this.perMinute);
    bucket.lastRefillMs = now;

    if (bucket.inFlight >= this.maxConcurrent) {
      throw new RateLimitError(`Too many concurrent calls to ${toolName}`, {
        toolName,
        maxConcurrent: this.maxConcurrent,
      });
    }
    if (bucket.tokens < 1) {
      throw new RateLimitError(`Rate limit exceeded for ${toolName}`, {
        toolName,
        perMinute: this.perMinute,
      });
    }
    bucket.tokens -= 1;
    bucket.inFlight += 1;

    let released = false;
    const b = bucket;
    return () => {
      if (released) return;
      released = true;
      b.inFlight -= 1;
    };
  }
}
