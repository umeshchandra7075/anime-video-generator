export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface RateLimiterAdapter {
  readonly name: "memory" | "redis";
  check(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
}
