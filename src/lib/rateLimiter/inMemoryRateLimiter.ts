import { RateLimiterAdapter, RateLimitResult } from "@/lib/rateLimiter/types";

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window rate limiting backed by an in-process Map. Correct for a
 * single Node process (local dev, or a single-instance deployment) but
 * does NOT share state across multiple horizontally-scaled instances -
 * use RedisRateLimiter (RATE_LIMIT_DRIVER=redis) for that. This is the
 * same zero-dependency-by-default / opt-in-Redis-for-scale split used for
 * the job queue (see src/lib/queue/jobQueueAdapter.ts).
 */
export class InMemoryRateLimiter implements RateLimiterAdapter {
  readonly name = "memory" as const;
  private buckets = new Map<string, Bucket>();

  async check(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const now = Date.now();
    const existing = this.buckets.get(key);

    if (!existing || existing.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      this.sweepOccasionally(now);
      return { allowed: true, retryAfterSeconds: 0 };
    }

    existing.count += 1;
    if (existing.count > limit) {
      return { allowed: false, retryAfterSeconds: Math.ceil((existing.resetAt - now) / 1000) };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Cheap opportunistic cleanup so this Map can't grow unbounded over a long-running process. */
  private sweepOccasionally(now: number) {
    if (Math.random() > 0.01) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}
