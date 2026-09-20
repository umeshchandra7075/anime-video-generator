// Retry with exponential backoff + jitter + per-attempt timeout. Every
// external provider call goes through this so failures are bounded, logged
// and classified instead of hanging a worker.

export interface RetryOptions {
  retries?: number; // additional attempts after the first (default 3)
  baseDelayMs?: number; // default 500
  maxDelayMs?: number; // default 15_000
  factor?: number; // default 2
  jitter?: boolean; // default true (full jitter on 50%..100% of delay)
  timeoutMs?: number; // per attempt (default 60_000)
  isRetryable?: (err: unknown) => boolean;
  onRetry?: (info: { attempt: number; maxAttempts: number; delayMs: number; error: unknown }) => void;
  sleep?: (ms: number) => Promise<void>; // injectable for tests
  random?: () => number; // injectable for tests
}

export class AttemptTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Operation timed out after ${timeoutMs}ms.`);
    this.name = "AttemptTimeoutError";
  }
}

export class RetriesExhaustedError extends Error {
  constructor(public readonly attempts: number, public readonly lastError: unknown) {
    super(`Failed after ${attempts} attempt(s): ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    this.name = "RetriesExhaustedError";
  }
}

/** Default: retry timeouts, network errors, 429 and 5xx; never retry 4xx auth/validation. */
export function defaultIsRetryable(err: unknown): boolean {
  if (err instanceof AttemptTimeoutError) return true;
  const status = (err as { statusCode?: number; status?: number } | null)?.statusCode ??
    (err as { status?: number } | null)?.status;
  if (typeof status === "number") return status === 429 || status === 408 || status >= 500;
  const name = (err as { name?: string } | null)?.name;
  if (name === "ProviderAuthError" || name === "ProviderNotConfiguredError") return false;
  const msg = err instanceof Error ? err.message : String(err);
  return /timed out|timeout|network|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up/i.test(msg);
}

export function computeBackoffMs(attemptIndex: number, o: Required<Pick<RetryOptions, "baseDelayMs" | "maxDelayMs" | "factor" | "jitter">>, random: () => number): number {
  const raw = Math.min(o.maxDelayMs, o.baseDelayMs * Math.pow(o.factor, attemptIndex));
  return o.jitter ? Math.round(raw * (0.5 + random() * 0.5)) : raw;
}

export async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AttemptTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function withRetry<T>(fn: (signal: AbortSignal, attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  const maxAttempts = retries + 1;
  const backoff = {
    baseDelayMs: opts.baseDelayMs ?? 500,
    maxDelayMs: opts.maxDelayMs ?? 15_000,
    factor: opts.factor ?? 2,
    jitter: opts.jitter ?? true,
  };
  const isRetryable = opts.isRetryable ?? defaultIsRetryable;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await withTimeout((signal) => fn(signal, attempt), opts.timeoutMs ?? 60_000);
    } catch (err) {
      lastError = err;
      if (!isRetryable(err)) throw err; // clear, original error - not wrapped
      if (attempt === maxAttempts) break;
      const delayMs = computeBackoffMs(attempt - 1, backoff, random);
      opts.onRetry?.({ attempt, maxAttempts, delayMs, error: err });
      await sleep(delayMs);
    }
  }
  throw new RetriesExhaustedError(maxAttempts, lastError);
}
