import { describe, it, expect } from "vitest";
import { withRetry, computeBackoffMs, RetriesExhaustedError, AttemptTimeoutError, defaultIsRetryable } from "../../src/lib/engine/retry";
import { hashParts, ttsCacheKey, stableStringify } from "../../src/lib/engine/cacheKey";

const noSleep = async () => undefined;

describe("withRetry", () => {
  it("retries transient failures with exponential backoff, then succeeds", async () => {
    const delays: number[] = [];
    let n = 0;
    const out = await withRetry(async () => { n++; if (n < 3) throw Object.assign(new Error("boom"), { statusCode: 503 }); return "ok"; },
      { retries: 3, baseDelayMs: 100, jitter: false, sleep: async (ms) => { delays.push(ms); }, onRetry: () => undefined });
    expect(out).toBe("ok");
    expect(n).toBe(3);
    expect(delays).toEqual([100, 200]);
  });
  it("reports Retry k/N via onRetry and gives up with RetriesExhaustedError", async () => {
    const seen: string[] = [];
    let n = 0;
    await expect(withRetry(async () => { n++; throw Object.assign(new Error("down"), { statusCode: 500 }); },
      { retries: 3, jitter: false, sleep: noSleep, onRetry: (i) => seen.push(`Retry ${i.attempt}/${i.maxAttempts - 1}`) })).rejects.toThrow(RetriesExhaustedError);
    expect(n).toBe(4);
    expect(seen).toEqual(["Retry 1/3", "Retry 2/3", "Retry 3/3"]);
  });
  it("does NOT retry auth / validation errors and rethrows the original error", async () => {
    let n = 0;
    const err = Object.assign(new Error("bad key"), { statusCode: 401 });
    await expect(withRetry(async () => { n++; throw err; }, { sleep: noSleep })).rejects.toThrow("bad key");
    expect(n).toBe(1);
  });
  it("times out a hung attempt (and retries it)", async () => {
    let n = 0;
    const out = await withRetry(async (signal) => { n++; if (n === 1) await new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))); return "recovered"; },
      { timeoutMs: 30, retries: 1, jitter: false, baseDelayMs: 1, sleep: noSleep });
    expect(out).toBe("recovered");
    expect(n).toBe(2);
  });
  it("classifies errors", () => {
    expect(defaultIsRetryable(new AttemptTimeoutError(5))).toBe(true);
    expect(defaultIsRetryable(Object.assign(new Error("x"), { statusCode: 429 }))).toBe(true);
    expect(defaultIsRetryable(Object.assign(new Error("x"), { statusCode: 400 }))).toBe(false);
    expect(defaultIsRetryable(new Error("fetch failed"))).toBe(true);
  });
  it("caps backoff at maxDelayMs", () => {
    expect(computeBackoffMs(20, { baseDelayMs: 500, maxDelayMs: 15000, factor: 2, jitter: false }, Math.random)).toBe(15000);
  });
});

describe("cache keys", () => {
  it("are independent of property order and whitespace noise", () => {
    expect(hashParts({ a: 1, b: { c: 2, d: 3 } })).toBe(hashParts({ b: { d: 3, c: 2 }, a: 1 }));
    expect(stableStringify({ x: undefined, y: 1 })).toBe('{"y":1}');
    const base = { characterId: "akira", provider: "elevenlabs", voiceId: "v1", text: "Where are you going?", emotion: "serious", speed: 1 };
    expect(ttsCacheKey(base)).toBe(ttsCacheKey({ ...base, text: "  Where   are you going? " }));
  });
  it("change when ANY synthesis-relevant parameter changes", () => {
    const base = { characterId: "akira", provider: "elevenlabs", model: "m1", voiceId: "v1", text: "Hi", emotion: "serious", speed: 1, pitch: 0 };
    const k = ttsCacheKey(base);
    for (const change of [{ characterId: "mika" }, { provider: "openai" }, { model: "m2" }, { voiceId: "v2" }, { text: "Hey" }, { emotion: "angry" }, { speed: 1.1 }, { pitch: 1 }]) {
      expect(ttsCacheKey({ ...base, ...change })).not.toBe(k);
    }
  });
});
