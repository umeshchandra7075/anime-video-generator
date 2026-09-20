import { RateLimiterAdapter } from "@/lib/rateLimiter/types";
import { InMemoryRateLimiter } from "@/lib/rateLimiter/inMemoryRateLimiter";

let singleton: RateLimiterAdapter | undefined;

export function getRateLimiter(): RateLimiterAdapter {
  if (!singleton) {
    if (process.env.RATE_LIMIT_DRIVER === "redis") {
      const mod = require("@/lib/rateLimiter/redisRateLimiter") as typeof import("@/lib/rateLimiter/redisRateLimiter");
      singleton = new mod.RedisRateLimiter();
    } else {
      singleton = new InMemoryRateLimiter();
    }
  }
  return singleton;
}
