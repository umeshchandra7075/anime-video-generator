import { describe, it, expect } from "vitest";
import { generateSceneVoices, VoiceStageError } from "../../src/lib/pipeline/voiceStage";
import type { VoiceStageDeps, VoiceSceneInput, VoiceCharacterInput } from "../../src/lib/pipeline/voiceStage";
import { validateTimeline } from "../../src/lib/engine/timeline";
import type { SceneTimeline } from "../../src/lib/engine/types";
import { synthVoice, writeWav, tmpDir, rmDir } from "./fixtures";
import fs from "node:fs";
import path from "node:path";

// ---- in-memory world -------------------------------------------------------
function world(opts: { env?: Record<string, string>; ttsBehaviour?: (req: any, n: number) => Promise<void> | void } = {}) {
  const blobs = new Map<string, Buffer>(); const characters = new Map<string, string | null>(); const sceneRows: Record<string, any> = {}; const assets: any[] = []; const events: any[] = [];
  const calls: any[] = []; let n = 0;
  const provider: any = {
    name: "elevenlabs", capabilities: { provider: "elevenlabs", speed: { min: 0.7, max: 1.2 }, stability: true, similarityBoost: true, style: true },
    async synthesize(req: any) {
      calls.push(req); n++; await opts.ttsBehaviour?.(req, n);
      const words = req.text.split(/\s+/); let t = 0.06; const ww: any[] = [];
      for (const w of words) { const d = 0.1 + 0.05 * w.length; ww.push({ start: t, end: t + d, f0: 140 }); t += d + 0.06; }
      const dir = tmpDir(); const f = writeWav(path.join(dir, "a.wav"), synthVoice({ duration: t + 0.1, words: ww })); const buf = fs.readFileSync(f); rmDir(dir);
      return { audioBase64: buf.toString("base64"), mimeType: "audio/wav", providerName: "elevenlabs", providerMetadata: { voiceId: req.voiceId } };
    },
  };
  const deps: VoiceStageDeps = {
    db: {
      character: { async update({ where, data }: any) { characters.set(where.id, data.voiceConfig); } },
      scene: { async update({ where, data }: any) { sceneRows[where.id] = { ...(sceneRows[where.id] ?? {}), ...data }; } },
      sceneAsset: { async deleteMany({ where }: any) { for (let i = assets.length - 1; i >= 0; i--) if (assets[i].sceneId === where.sceneId && assets[i].type === where.type) assets.splice(i, 1); }, async create({ data }: any) { assets.push(data); } },
      jobEvent: { async create({ data }: any) { events.push(data); } },
    },
    store: { async exists(k) { return blobs.has(k); }, async get(k) { return blobs.get(k)!; }, async put(k, d) { blobs.set(k, d); } },
    keyFor: (pid, ck, ext) => `projects/${pid}/dialogue/${ck}.${ext}`,
    tts: () => provider, env: { ELEVENLABS_DEFAULT_VOICE_ID: "default_voice", VOICE_POOL_JSON: JSON.stringify([{ voiceId: "pool_m1", gender: "male" }, { voiceId: "pool_f1", gender: "female" }, { voiceId: "pool_m2", gender: "male" }]), ...(opts.env ?? {}) } as NodeJS.ProcessEnv,
  };
  return { deps, blobs, characters, sceneRows, assets, events, calls };
}
const scene = (n: number, dialogue: unknown[], extra: Partial<VoiceSceneInput> = {}): VoiceSceneInput => ({ id: `sc${n}`, sceneNumber: n, narration: null, dialogue: JSON.stringify(dialogue), characterIds: JSON.stringify(["akira", "mika"]), soundEffects: JSON.stringify([]), estimatedSeconds: 5, ...extra });
const chars = (): VoiceCharacterInput[] => [{ id: "akira", name: "Akira", gender: "male", voiceConfig: JSON.stringify({ voiceId: "voice_akira_001", defaultEmotion: "serious" }) }, { id: "mika", name: "Mika", gender: "female", voiceConfig: null }];

describe("generateSceneVoices (real stage code, fake DB/storage/provider)", () => {
  it("synthesises per line with each speaker's own voice, persists the timeline + assets, and durations come from the audio", async () => {
    const w = world();
    const r = await generateSceneVoices("p1", [scene(1, [{ character: "Akira", line: "Where are you going?" }, { character: "Mika", line: "Out." }, { character: "Akira", line: "Wait." }])], "en", "neutral", "narrator", chars(), { deps: w.deps, fps: 24 });
    expect(w.calls.map((c) => c.voiceId)).toEqual(["voice_akira_001", "pool_f1", "voice_akira_001"]);
    const tl = JSON.parse(w.sceneRows.sc1.timeline) as SceneTimeline;
    expect(tl.segments.map((s) => s.characterId)).toEqual(["akira", "mika", "akira"]);
    expect(validateTimeline(tl)).toEqual([]);
    expect(tl.duration * 24).toBeCloseTo(Math.round(tl.duration * 24), 6);          // frame-snapped
    expect(w.sceneRows.sc1.estimatedSeconds).toBe(Math.ceil(tl.duration));
    expect(w.assets.filter((a) => a.type === "DIALOGUE_AUDIO")).toHaveLength(3);
    expect(r.stats).toMatchObject({ segments: 3, synthesized: 3, failed: 0 });
  });
  it("casts a distinct voice to a character without one, PERSISTS it, and keeps it on the next run", async () => {
    const w = world();
    await generateSceneVoices("p1", [scene(1, [{ character: "Mika", line: "Hello." }])], "en", "neutral", "narrator", chars(), { deps: w.deps });
    const saved = JSON.parse(w.characters.get("mika")!); expect(saved).toMatchObject({ voiceId: "pool_f1", provider: "elevenlabs" });
    expect(w.characters.has("akira")).toBe(false);                                   // already had a voice: untouched
    const w2 = world(); const persisted = chars().map((c) => c.id === "mika" ? { ...c, voiceConfig: w.characters.get("mika")! } : c);
    await generateSceneVoices("p1", [scene(1, [{ character: "Mika", line: "Hello." }])], "en", "neutral", "narrator", persisted, { deps: w2.deps });
    expect(w2.calls[0].voiceId).toBe("pool_f1"); expect(w2.characters.size).toBe(0);  // same voice, nothing re-cast
  });
  it("re-running the same scene is fully cached: zero TTS calls, identical timeline", async () => {
    const w = world(); const sc = scene(1, [{ character: "Akira", line: "Same line." }, { character: "Mika", line: "Same reply." }]);
    await generateSceneVoices("p1", [sc], "en", "neutral", "narrator", chars(), { deps: w.deps });
    const first = w.sceneRows.sc1.timeline; const before = w.calls.length;
    const r2 = await generateSceneVoices("p1", [sc], "en", "neutral", "narrator", chars(), { deps: w.deps });
    expect(w.calls.length).toBe(before); expect(r2.stats).toMatchObject({ synthesized: 0, cached: 2 });
    expect(w.sceneRows.sc1.timeline).toBe(first);
    expect(w.assets.filter((a) => a.type === "DIALOGUE_AUDIO")).toHaveLength(2);      // replaced, not duplicated
  });
  it("REGENERATE ONE SCENE: editing one line re-synthesises only that line", async () => {
    const w = world();
    const s1 = scene(1, [{ character: "Akira", line: "Scene one." }]), s2 = scene(2, [{ character: "Akira", line: "Scene two." }]);
    await generateSceneVoices("p1", [s1, s2], "en", "neutral", "narrator", chars(), { deps: w.deps });
    const before = w.calls.length;
    await generateSceneVoices("p1", [s1, scene(2, [{ character: "Akira", line: "Scene two, edited." }])], "en", "neutral", "narrator", chars(), { deps: w.deps });
    expect(w.calls.slice(before).map((c) => c.text)).toEqual(["Scene two, edited."]);
  });
  it("EMOTION per line changes the provider request; an explicit emotion beats the character default", async () => {
    const w = world();
    await generateSceneVoices("p1", [scene(1, [{ character: "Akira", line: "Calm now.", emotion: "calm" }, { character: "Akira", line: "Get out.", emotion: "angry" }, { character: "Akira", line: "Fine." }])], "en", "neutral", "narrator", chars(), { deps: w.deps });
    const [calm, angry, dflt] = w.calls; expect(angry.speed).toBeGreaterThan(calm.speed); expect(angry.stability).toBeLessThan(calm.stability);
    const tl = JSON.parse(w.sceneRows.sc1.timeline) as SceneTimeline; expect(tl.segments[2]!.emotion).toBe("serious"); void dflt;  // character default
  });
  it("MISSING API KEY: fails the stage with the honest message - no fake success, nothing persisted", async () => {
    const w = world({ ttsBehaviour: () => { throw Object.assign(new Error("x"), { name: "ProviderNotConfiguredError" }); } });
    await expect(generateSceneVoices("p1", [scene(1, [{ character: "Akira", line: "Hi." }])], "en", "neutral", "narrator", chars(), { deps: w.deps })).rejects.toThrow("ElevenLabs API key is not configured.");
    expect(w.sceneRows.sc1).toBeUndefined(); expect(w.assets).toHaveLength(0);
    try { await generateSceneVoices("p1", [scene(1, [{ character: "Akira", line: "Hi." }])], "en", "neutral", "narrator", chars(), { deps: w.deps }); } catch (e) { expect(e).toBeInstanceOf(VoiceStageError); expect((e as VoiceStageError).code).toBe("PROVIDER_NOT_CONFIGURED"); expect((e as VoiceStageError).retryable).toBe(false); }
  });
  it("ONE failing line is skipped and recorded; the rest of the project continues (component-level failure)", async () => {
    const w = world({ ttsBehaviour: (req) => { if (req.text === "Broken line.") throw Object.assign(new Error("upstream 500"), { statusCode: 500 }); } });
    const r = await generateSceneVoices("p1", [scene(1, [{ character: "Akira", line: "Good." }, { character: "Mika", line: "Broken line." }, { character: "Akira", line: "Also good." }])], "en", "neutral", "narrator", chars(), { deps: { ...w.deps, env: { ...w.deps.env, VOICE_CONCURRENCY: "1" } as NodeJS.ProcessEnv } });
    expect(r.stats.failed).toBe(1);
    const tl = JSON.parse(w.sceneRows.sc1.timeline) as SceneTimeline; expect(tl.segments.map((s) => s.text)).toEqual(["Good.", "Also good."]); expect(validateTimeline(tl)).toEqual([]);
    const issues = JSON.parse(w.sceneRows.sc1.componentIssues); expect(issues.some((i: any) => i.component === "voice" && /Mika/.test(i.message) && /regenerate/i.test(i.message))).toBe(true);
    expect(w.events.some((e) => /1 of 3 line/.test(e.message))).toBe(true);
  }, 30000);
  it("if EVERY line fails the stage fails (never a silent 'successful' video)", async () => {
    const w = world({ ttsBehaviour: () => { throw Object.assign(new Error("down"), { statusCode: 503 }); } });
    await expect(generateSceneVoices("p1", [scene(1, [{ character: "Akira", line: "Hi." }])], "en", "neutral", "narrator", chars(), { deps: w.deps })).rejects.toThrow(/every line/);
  }, 30000);
  it("an unknown speaker is reported and gets the default voice, never a cast member's", async () => {
    const w = world();
    await generateSceneVoices("p1", [scene(1, [{ character: "Mystery Man", line: "Boo." }])], "en", "neutral", "narrator", chars(), { deps: w.deps });
    expect(w.calls[0].voiceId).toBe("default_voice");
    expect(JSON.parse(w.sceneRows.sc1.componentIssues).map((i: any) => i.code)).toContain("UNKNOWN_SPEAKER");
  });
  it("narration is its own narrator segment first; pool exhaustion is warned about instead of silently sharing voices", async () => {
    const w = world({ env: { VOICE_POOL_JSON: JSON.stringify([{ voiceId: "only_one" }]) } });
    const many: VoiceCharacterInput[] = [{ id: "a", name: "A", voiceConfig: null }, { id: "b", name: "B", voiceConfig: null }];
    await generateSceneVoices("p1", [scene(1, [{ character: "A", line: "x." }, { character: "B", line: "y." }], { narration: "Once.", characterIds: JSON.stringify(["a", "b"]) })], "en", "neutral", "narrator", many, { deps: w.deps });
    const tl = JSON.parse(w.sceneRows.sc1.timeline) as SceneTimeline; expect(tl.segments[0]!.characterId).toBe("narrator");
    expect(JSON.parse(w.sceneRows.sc1.componentIssues).some((i: any) => i.component === "casting" && /default voice/.test(i.message))).toBe(true);
  });
  it("a SILENT scene (no narration, no dialogue) makes no TTS call and keeps its planned duration", async () => {
    const w = world();
    await generateSceneVoices("p1", [scene(1, [], { estimatedSeconds: 6 })], "en", "neutral", "narrator", chars(), { deps: w.deps });
    expect(w.calls).toHaveLength(0);
    const tl = JSON.parse(w.sceneRows.sc1.timeline) as SceneTimeline; expect(tl.durationSource).toBe("planned"); expect(tl.duration).toBe(6);
  });
  it("narration-only scene with no characters configured uses the DEFAULT voice for the narrator", async () => {
    const w = world();
    await generateSceneVoices("p1", [scene(1, [], { narration: "A quiet morning.", characterIds: "[]" })], "en", "neutral", "narrator", [], { deps: w.deps });
    expect(w.calls[0].voiceId).toBe("default_voice");
  });
  it("NARRATOR_VOICE_ID overrides the default narrator voice", async () => {
    const w = world({ env: { NARRATOR_VOICE_ID: "narrator_special" } });
    await generateSceneVoices("p1", [scene(1, [], { narration: "A quiet morning.", characterIds: "[]" })], "en", "neutral", "narrator", [], { deps: w.deps });
    expect(w.calls[0].voiceId).toBe("narrator_special");
  });
  it("reports real progress that ends at 1", async () => {
    const w = world(); const seen: number[] = [];
    await generateSceneVoices("p1", [scene(1, [{ character: "Akira", line: "One." }]), scene(2, [{ character: "Mika", line: "Two." }])], "en", "neutral", "narrator", chars(), { deps: w.deps, onProgress: (f) => { seen.push(f); } });
    expect(seen[seen.length - 1]).toBe(1); expect(Math.max(...seen)).toBeLessThanOrEqual(1);
  });
});
