import { RateLimiterAdapter, RateLimitResult } from "@/lib/rateLimiter/types";
import { getRedis } from "@/lib/queue/connection";

export class RedisRateLimiter implements RateLimiterAdapter {
  readonly name = "redis" as const;

  async check(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const redis = getRedis();
    const redisKey = `ratelimit:${key}`;

    const count = await redis.incr(redisKey);
    if (count === 1) {
      await redis.expire(redisKey, windowSeconds);
    }

    if (count > limit) {
      const ttl = await redis.ttl(redisKey);
      return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : windowSeconds };
    }

    return { allowed: true, retryAfterSeconds: 0 };
  }
}
