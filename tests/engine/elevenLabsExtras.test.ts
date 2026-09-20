import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ElevenLabsTtsProvider } from "../../src/lib/ai/providers/elevenlabs/elevenlabs-tts-provider";
import { ProviderTimeoutError } from "../../src/lib/ai/errors/provider-errors";

const realFetch = globalThis.fetch;
const req = { text: "map the ship", language: "en", voiceGender: "neutral" as const, voiceStyle: "calm", voiceId: "v1" };
let calls: Array<{ url: string; init: RequestInit }> = [];
const stub = (fn: (url: string, init: RequestInit) => Promise<any>) => { calls = []; (globalThis as any).fetch = (url: string, init: RequestInit) => { calls.push({ url, init }); return fn(url, init); }; };

describe("ElevenLabsTtsProvider additions", () => {
  beforeEach(() => { process.env.ELEVENLABS_API_KEY = "k"; delete process.env.ELEVENLABS_USE_TIMESTAMPS; });
  afterEach(() => { globalThis.fetch = realFetch; delete process.env.ELEVENLABS_USE_TIMESTAMPS; });
  it("declares only what the API exposes (no pitch, no free-text instructions)", () => {
    const c = new ElevenLabsTtsProvider().capabilities!;
    expect(c.speed).toEqual({ min: 0.7, max: 1.2 }); expect(c.stability && c.similarityBoost && c.style).toBe(true);
    expect(c.pitch).toBeUndefined(); expect(c.instructions).toBeUndefined();
  });
  it("a hung request is aborted and reported as a timeout (retryable by the voice pipeline)", async () => {
    stub((_u, init) => new Promise((_, rej) => (init.signal as AbortSignal).addEventListener("abort", () => rej(new Error("aborted")))));
    await expect(new ElevenLabsTtsProvider().synthesize({ ...req, timeoutMs: 30 })).rejects.toBeInstanceOf(ProviderTimeoutError);
  });
  it("timestamps are OFF unless explicitly enabled: same endpoint and audio/mpeg even when requested", async () => {
    stub(async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2]).buffer }));
    const r = await new ElevenLabsTtsProvider().synthesize({ ...req, withTimestamps: true });
    expect(calls[0]!.url).toMatch(/\/text-to-speech\/v1$/); expect(r.alignment).toBeUndefined();
  });
  it("with ELEVENLABS_USE_TIMESTAMPS=true, parses base64 audio + character alignment from the documented response shape", async () => {
    process.env.ELEVENLABS_USE_TIMESTAMPS = "true";
    stub(async () => ({ ok: true, status: 200, json: async () => ({ audio_base64: Buffer.from("AUDIO").toString("base64"), alignment: { characters: ["m", "a", "p"], character_start_times_seconds: [0, 0.1, 0.2], character_end_times_seconds: [0.1, 0.2, 0.3] } }) }));
    const r = await new ElevenLabsTtsProvider().synthesize({ ...req, text: "map", withTimestamps: true });
    expect(calls[0]!.url).toMatch(/\/text-to-speech\/v1\/with-timestamps$/);
    expect(Buffer.from(r.audioBase64, "base64").toString()).toBe("AUDIO");
    expect(r.alignment).toEqual({ characters: ["m", "a", "p"], startTimes: [0, 0.1, 0.2], endTimes: [0.1, 0.2, 0.3] });
  });
  it("a timestamps response without alignment still returns the audio (alignment simply absent)", async () => {
    process.env.ELEVENLABS_USE_TIMESTAMPS = "true";
    stub(async () => ({ ok: true, status: 200, json: async () => ({ audio_base64: Buffer.from("A").toString("base64") }) }));
    const r = await new ElevenLabsTtsProvider().synthesize({ ...req, withTimestamps: true });
    expect(r.alignment).toBeUndefined(); expect(r.audioBase64.length).toBeGreaterThan(0);
  });
});
