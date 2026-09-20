import { describe, it, expect } from "vitest";
import { synthesizeSegments } from "../../src/lib/engine/voicePipeline";
import type { BlobStore, VoiceSynth, SynthRequest, Analyzer } from "../../src/lib/engine/voicePipeline";
import { planDialogueSegments } from "../../src/lib/engine/dialogue";
import type { CharacterInfo } from "../../src/lib/engine/dialogue";
import { buildSceneTimeline, validateTimeline } from "../../src/lib/engine/timeline";
import type { SegmentAudio } from "../../src/lib/engine/types";

const chars: CharacterInfo[] = [
  { id: "akira", name: "Akira", voice: { provider: "elevenlabs", voiceId: "voice_akira_001" }, defaultEmotion: "serious" },
  { id: "mika", name: "Mika", voice: { provider: "elevenlabs", voiceId: "voice_mika_001" } },
  { id: "ren", name: "Ren", voice: { provider: "elevenlabs", voiceId: "voice_ren_001" } },
];
class MemStore implements BlobStore {
  m = new Map<string, Buffer>(); puts = 0;
  async exists(k: string) { return this.m.has(k); } async get(k: string) { return this.m.get(k)!; }
  async put(k: string, d: Buffer) { this.puts++; this.m.set(k, d); }
}
// "audio" = the text itself; the fake analyzer measures a duration from it (0.08 s per character) - a stand-in for real decoding.
const analyze: Analyzer = async (audio) => { const t = audio.toString(); if (t.startsWith("SILENT")) return { durationSeconds: 1, speechRegions: [] }; const d = t.length * 0.08; return { durationSeconds: d, speechRegions: [{ start: 0.05, end: d - 0.05 }] }; };
function fakeProvider(behaviour?: (req: SynthRequest, call: number) => Promise<Buffer | "silent"> | Buffer | "silent") {
  const calls: SynthRequest[] = [];
  const p: VoiceSynth & { calls: SynthRequest[] } = {
    name: "elevenlabs", calls,
    capabilities: { provider: "elevenlabs", speed: { min: 0.7, max: 1.2 }, stability: true, similarityBoost: true, style: true },
    async synthesize(req) { calls.push(req); const r = await (behaviour ? behaviour(req, calls.length) : Buffer.from(req.text)); return { audio: r === "silent" ? Buffer.from("SILENT") : r, mimeType: "audio/mpeg" }; },
  };
  return p;
}
const fastRetry = { retries: 3, baseDelayMs: 1, jitter: false, sleep: async () => undefined, timeoutMs: 2000 };
const base = { language: "en", keyFor: (k: string, e: string) => `p/dialogue/${k}.${e}`, settingsFor: () => ({ base: { stability: 0.5, similarityBoost: 0.8, style: 0.3, speed: 1 }, voiceId: "default_voice" }), analyze, retry: fastRetry } as const;
const plan = (lines: Array<[string, string, string?]>, cs = chars) => planDialogueSegments({ sceneNumber: 1, characters: cs, dialogue: lines.map(([character, line, emotion]) => ({ character, line, emotion })) }).segments;

describe("voice pipeline: per-segment, per-speaker synthesis", () => {
  it("TWO characters: A,B,A lines are synthesised with A's, B's, A's own voice", async () => {
    const provider = fakeProvider();
    const out = await synthesizeSegments({ ...base, provider, store: new MemStore(), segments: plan([["Akira", "Where are you going?"], ["Mika", "Out."], ["Akira", "Wait."]]) });
    expect(out.every((o) => o.ok)).toBe(true);
    expect(provider.calls.map((c) => c.voiceId)).toEqual(["voice_akira_001", "voice_mika_001", "voice_akira_001"]);
  });
  it("THREE characters keep three distinct voices; parallel synthesis still maps each request to the right speaker", async () => {
    const provider = fakeProvider();
    const segs = plan([["Ren", "one"], ["Akira", "two"], ["Mika", "three"], ["Ren", "four"]]);
    const out = await synthesizeSegments({ ...base, provider, store: new MemStore(), segments: segs, concurrency: 4 });
    out.forEach((o, i) => { expect(o.ok).toBe(true); const want = segs[i]!.voice!.voiceId; expect(provider.calls.find((c) => c.text === segs[i]!.text)!.voiceId).toBe(want); });
    expect(new Set(provider.calls.map((c) => c.voiceId)).size).toBe(3);
  });
  it("durations are MEASURED from the audio and drive the scene timeline (audio-first), end to end", async () => {
    const provider = fakeProvider();
    const segs = plan([["Akira", "Where are you going?", "serious"], ["Mika", "Somewhere you cannot follow.", "sad"]]);
    const out = await synthesizeSegments({ ...base, provider, store: new MemStore(), segments: segs });
    const ok = out.filter((o) => o.ok) as Array<Extract<(typeof out)[number], { ok: true }>>;
    const tl = buildSceneTimeline({ sceneId: "s", sceneNumber: 1, fps: 24, language: "en", onScreen: ["akira", "mika"], sceneText: "", sfxHints: [], musicMood: null, isFirstScene: false, plannedSeconds: 2,
      segments: ok.map((o) => ({ planned: o.segment, audio: o.audio as SegmentAudio })) });
    expect(tl.segments[0]!.duration).toBeCloseTo("Where are you going?".length * 0.08, 5);
    expect(tl.segments[1]!.duration).toBeCloseTo("Somewhere you cannot follow.".length * 0.08, 5);
    expect(tl.duration).toBeGreaterThan(tl.segments[1]!.endTime);
    expect(validateTimeline(tl)).toEqual([]);
  });
  it("EMOTION changes the request only through supported parameters; unsupported ones are reported", async () => {
    const provider = fakeProvider();
    const out = await synthesizeSegments({ ...base, provider, store: new MemStore(), segments: plan([["Akira", "Get out.", "angry"], ["Akira", "It is fine.", "calm"]]) });
    const [angry, calm] = provider.calls;
    expect(angry!.speed).toBeGreaterThan(calm!.speed!);
    expect(angry!.stability).toBeLessThan(calm!.stability!);
    expect(angry!.instructions).toBeUndefined();            // ElevenLabs has no instruction control
    expect(out[0]!.ok && out[0]!.ignoredParams).toContain("pitch");
  });
  it("an UNKNOWN speaker gets the default voice, never a real character's", async () => {
    const provider = fakeProvider();
    await synthesizeSegments({ ...base, provider, store: new MemStore(), segments: plan([["Stranger", "Hello."]]) });
    expect(provider.calls[0]!.voiceId).toBe("default_voice");
    expect(["voice_akira_001", "voice_mika_001", "voice_ren_001"]).not.toContain(provider.calls[0]!.voiceId);
  });
  it("pronunciation lexicon changes the SPOKEN text only", async () => {
    const provider = fakeProvider();
    const segs = plan([["Akira", "Akira is here."]]);
    await synthesizeSegments({ ...base, provider, store: new MemStore(), segments: segs, settingsFor: () => ({ base: {}, lexicon: { Akira: "Ah-kee-rah" } }) });
    expect(provider.calls[0]!.text).toBe("Ah-kee-rah is here.");
    expect(segs[0]!.text).toBe("Akira is here.");
  });
});

describe("voice pipeline: caching", () => {
  it("identical request => zero provider calls, identical audio reference and measured duration", async () => {
    const store = new MemStore(); const segs = plan([["Akira", "Where are you going?"], ["Mika", "Out."]]);
    const p1 = fakeProvider(); const r1 = await synthesizeSegments({ ...base, provider: p1, store, segments: segs });
    const p2 = fakeProvider(); const r2 = await synthesizeSegments({ ...base, provider: p2, store, segments: segs });
    expect(p1.calls).toHaveLength(2); expect(p2.calls).toHaveLength(0);
    r2.forEach((o, i) => { expect(o.ok && o.cached).toBe(true); expect(o.ok && o.audio.storageKey).toBe((r1[i] as { audio: SegmentAudio }).audio.storageKey); expect(o.ok && o.audio.durationSeconds).toBe((r1[i] as { audio: SegmentAudio }).audio.durationSeconds); });
  });
  it("SCENE REGENERATION re-synthesises only what changed (one edited line, one changed emotion)", async () => {
    const store = new MemStore();
    const v1 = plan([["Akira", "Line one.", "calm"], ["Mika", "Line two.", "calm"], ["Ren", "Line three.", "calm"]]);
    await synthesizeSegments({ ...base, provider: fakeProvider(), store, segments: v1 });
    const p = fakeProvider();
    const v2 = plan([["Akira", "Line one.", "calm"], ["Mika", "Line two, edited.", "calm"], ["Ren", "Line three.", "angry"]]);
    await synthesizeSegments({ ...base, provider: p, store, segments: v2 });
    expect(p.calls.map((c) => c.text).sort()).toEqual(["Line three.", "Line two, edited."]);
  });
  it("a different voice or provider setting is a different cache entry", async () => {
    const store = new MemStore(); const p = fakeProvider();
    await synthesizeSegments({ ...base, provider: p, store, segments: plan([["Akira", "Same."]]) });
    const other = chars.map((c) => c.id === "akira" ? { ...c, voice: { provider: "elevenlabs", voiceId: "voice_akira_002" } } : c);
    await synthesizeSegments({ ...base, provider: p, store, segments: plan([["Akira", "Same."]], other) });
    expect(p.calls).toHaveLength(2);
  });
  it("emotion is part of the cache key even for a provider with NO tunable parameters (spec: key includes emotion)", async () => {
    const store = new MemStore();
    const bare = () => { const p = fakeProvider(); (p as { capabilities: unknown }).capabilities = { provider: "elevenlabs" }; return p; };
    const a = bare(); await synthesizeSegments({ ...base, provider: a, store, segments: plan([["Akira", "Same words.", "calm"]]) });
    const b = bare(); await synthesizeSegments({ ...base, provider: b, store, segments: plan([["Akira", "Same words.", "angry"]]) });
    expect(b.calls).toHaveLength(1);
  });
  it("identical lines inside one run are synthesised once", async () => {
    const p = fakeProvider();
    await synthesizeSegments({ ...base, provider: p, store: new MemStore(), segments: plan([["Akira", "Hm."], ["Akira", "Hm."], ["Akira", "Hm."]]), concurrency: 3 });
    expect(p.calls).toHaveLength(1);
  });
});

describe("voice pipeline: failure handling", () => {
  it("retries transient provider errors with backoff and succeeds (Retry 1/3, 2/3)", async () => {
    const logs: string[] = [];
    const p = fakeProvider((req, n) => { if (n < 3) throw Object.assign(new Error("upstream"), { statusCode: 503 }); return Buffer.from(req.text); });
    const out = await synthesizeSegments({ ...base, provider: p, store: new MemStore(), segments: plan([["Akira", "Hello there."]]), log: (l) => logs.push(l) });
    expect(out[0]!.ok && out[0]!.attempts).toBe(3);
    expect(logs.filter((l) => /Retry \d\/3/.test(l))).toHaveLength(2);
  });
  it("a hung provider call times out and is retried", async () => {
    const p = fakeProvider(async (req, n) => { if (n === 1) await new Promise((r) => setTimeout(r, 500)); return Buffer.from(req.text); });
    const out = await synthesizeSegments({ ...base, provider: p, store: new MemStore(), segments: plan([["Akira", "Hello."]]), retry: { ...fastRetry, timeoutMs: 40 } });
    expect(out[0]!.ok).toBe(true); expect(p.calls).toHaveLength(2);
  });
  it("ONE failing line fails only that segment - its siblings still succeed", async () => {
    const p = fakeProvider((req) => { if (req.text === "Bad line.") throw Object.assign(new Error("nope"), { statusCode: 500 }); return Buffer.from(req.text); });
    const out = await synthesizeSegments({ ...base, provider: p, store: new MemStore(), segments: plan([["Akira", "Good one."], ["Mika", "Bad line."], ["Ren", "Good two."]]), concurrency: 1 });
    expect(out.map((o) => o.ok)).toEqual([true, false, true]);
    const bad = out[1]!; expect(!bad.ok && bad.error.code).toBe("PROVIDER");
    expect(p.calls.filter((c) => c.text === "Bad line.")).toHaveLength(4); // 1 + 3 retries, then gives up
  });
  it("missing API key: honest message, NOT retried, and no further calls are made", async () => {
    const p = fakeProvider(() => { throw Object.assign(new Error('Provider "elevenlabs" is not configured.'), { name: "ProviderNotConfiguredError" }); });
    const out = await synthesizeSegments({ ...base, provider: p, store: new MemStore(), segments: plan([["Akira", "a1"], ["Mika", "b2"], ["Ren", "c3"]]), concurrency: 1 });
    expect(p.calls).toHaveLength(1);
    for (const o of out) { expect(o.ok).toBe(false); expect(!o.ok && o.error.message).toBe("ElevenLabs API key is not configured."); expect(!o.ok && o.error.code).toBe("NOT_CONFIGURED"); }
  });
  it("auth failure is reported as such and not retried", async () => {
    const p = fakeProvider(() => { throw Object.assign(new Error("x"), { name: "ProviderAuthError" }); });
    const out = await synthesizeSegments({ ...base, provider: p, store: new MemStore(), segments: plan([["Akira", "hi"]]) });
    expect(p.calls).toHaveLength(1); expect(!out[0]!.ok && out[0]!.error.code).toBe("AUTH");
  });
  it("silent or empty audio from the provider is a failure, not a success", async () => {
    const silent = await synthesizeSegments({ ...base, provider: fakeProvider(() => "silent"), store: new MemStore(), segments: plan([["Akira", "Say something."]]), retry: { ...fastRetry, retries: 0 } });
    expect(!silent[0]!.ok && silent[0]!.error.code).toBe("SILENT_AUDIO");
    const empty = await synthesizeSegments({ ...base, provider: fakeProvider(() => Buffer.alloc(0)), store: new MemStore(), segments: plan([["Akira", "Say something."]]) });
    expect(!empty[0]!.ok && empty[0]!.error.code).toBe("EMPTY_AUDIO");
  });
  it("failed segments are NOT written to the cache", async () => {
    const store = new MemStore();
    await synthesizeSegments({ ...base, provider: fakeProvider(() => "silent"), store, segments: plan([["Akira", "Say something."]]), retry: { ...fastRetry, retries: 0 } });
    expect(store.puts).toBe(0);
  });
  it("provider-returned character alignment is carried into the segment audio", async () => {
    const p = fakeProvider(); const orig = p.synthesize.bind(p);
    p.synthesize = async (r, s) => ({ ...(await orig(r, s)), alignment: { characters: [...r.text], startTimes: [...r.text].map((_, i) => i * 0.05), endTimes: [...r.text].map((_, i) => i * 0.05 + 0.05) } });
    const out = await synthesizeSegments({ ...base, provider: p, store: new MemStore(), segments: plan([["Akira", "map"]]), useTimestamps: true });
    expect(out[0]!.ok && out[0]!.audio.alignment!.characters.join("")).toBe("map");
  });
});
