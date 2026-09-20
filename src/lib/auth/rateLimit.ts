import { getRateLimiter } from "@/lib/rateLimiter/factory";

/**
 * In-memory by default (zero dependencies - see InMemoryRateLimiter), Redis
 * optional via RATE_LIMIT_DRIVER=redis for multi-instance production. The
 * call sites below never need to know which is active.
 */
export async function checkRateLimit(params: {
  key: string;
  limit: number;
  windowSeconds: number;
}): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  return getRateLimiter().check(params.key, params.limit, params.windowSeconds);
}

/** Convenience wrapper for login brute-force protection, keyed by email + IP. */
export async function checkLoginRateLimit(email: string, ip: string) {
  const byIp = await checkRateLimit({ key: `login:ip:${ip}`, limit: 20, windowSeconds: 600 });
  if (!byIp.allowed) return byIp;
  return checkRateLimit({ key: `login:email:${email.toLowerCase()}`, limit: 8, windowSeconds: 600 });
}
