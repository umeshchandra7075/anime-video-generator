import { describe, it, expect } from "vitest";
import { generateSceneLipSync } from "../../src/lib/pipeline/lipSyncStage";
import type { LipSyncStageDeps } from "../../src/lib/pipeline/lipSyncStage";
import { buildSceneTimeline } from "../../src/lib/engine/timeline";
import { planDialogueSegments } from "../../src/lib/engine/dialogue";
import type { SceneTimeline } from "../../src/lib/engine/types";

const CH = [{ id: "akira", name: "Akira", voice: { provider: "x", voiceId: "a" } }, { id: "mika", name: "Mika", voice: { provider: "x", voiceId: "m" } }];
function timeline(n: number, lines: Array<[string, string]>, narration?: string): SceneTimeline {
  const { segments } = planDialogueSegments({ sceneNumber: n, characters: CH, narration, narratorVoice: { provider: "x", voiceId: "n" }, dialogue: lines.map(([character, line]) => ({ character, line })) });
  return buildSceneTimeline({ sceneId: `sc${n}`, sceneNumber: n, fps: 24, language: "en", onScreen: ["akira", "mika"], sceneText: "", sfxHints: [], musicMood: null, isFirstScene: n === 1, plannedSeconds: 4,
    segments: segments.map((planned, i) => ({ planned, audio: { storageKey: `dlg/${planned.segmentId}.mp3`, mimeType: "audio/mpeg", durationSeconds: 1.5, cacheKey: `ck-${planned.segmentId}`, speechRegions: [{ start: 0.05, end: 1.45 }] } })) });
}

function harness(o: { configured?: boolean; enabled?: boolean; providerBehaviour?: "ok" | "fail" | "hang" | "flaky"; validate?: { ok: boolean; durationSeconds: number; reason?: string } } = {}) {
  const assets: any[] = []; const sceneRows: Record<string, any> = {}; const events: string[] = []; const submits: any[] = []; const stems: Array<{ speaker: string; files: string[] }> = []; let polls = 0, submitAttempts = 0;
  const store = new Map<string, Buffer>();
  const provider: any = {
    name: "test-lipsync",
    async submit(req: any) { submitAttempts++; if (o.providerBehaviour === "flaky" && submitAttempts === 1) throw Object.assign(new Error("upstream"), { statusCode: 503 }); submits.push(req); return { providerJobId: "job1", status: "queued" }; },
    async getStatus() { polls++; if (o.providerBehaviour === "fail") return { status: "failed", errorMessage: "face not detected" }; if (o.providerBehaviour === "hang") return { status: "processing" }; return { status: "completed", videoBase64: Buffer.from("LIPSYNCED").toString("base64"), mimeType: "video/mp4" }; },
    async cancel() { events.push("cancelled"); },
  };
  const deps: LipSyncStageDeps = {
    db: {
      scene: { async update({ where, data }: any) { sceneRows[where.id] = { ...(sceneRows[where.id] ?? {}), ...data }; } },
      sceneAsset: {
        async findMany({ where }: any) { const types: string[] = where.type.in; return assets.filter((a) => a.sceneId === where.sceneId && types.includes(a.type)); },
        async deleteMany({ where }: any) { for (let i = assets.length - 1; i >= 0; i--) if (assets[i].sceneId === where.sceneId && assets[i].type === where.type) assets.splice(i, 1); },
        async create({ data }: any) { assets.push(data); },
      },
      jobEvent: { async create({ data }: any) { events.push(data.message); } },
    },
    store: { async get(k) { return store.get(k) ?? Buffer.from("bytes:" + k); }, async put(k, d) { store.set(k, d); }, key: (pid, ...parts) => `projects/${pid}/${parts.join("/")}` },
    provider: () => provider, configured: () => o.configured ?? true, enabled: () => o.enabled ?? true,
    buildSpeakerStem: async (tl, speaker, files) => { stems.push({ speaker, files: Object.keys(files).sort() }); return Buffer.from("WAV-STEM-" + speaker); },
    validateClip: async () => o.validate ?? { ok: true, durationSeconds: 3.5 },
    sleep: async () => undefined, pollIntervalMs: 1, pollTimeoutMs: 40, maxDurationDriftSec: 1.5, retry: { retries: 2, baseDelayMs: 1 },
  };
  const seedScene = (tl: SceneTimeline, withClip = true) => {
    if (withClip) assets.push({ sceneId: tl.sceneId, type: "VIDEO_CLIP", storageKey: `clip/${tl.sceneNumber}.mp4`, providerMetadata: null });
    for (const s of tl.segments) assets.push({ sceneId: tl.sceneId, type: "DIALOGUE_AUDIO", storageKey: s.audio.storageKey, providerMetadata: JSON.stringify({ segmentId: s.segmentId }) });
    return { id: tl.sceneId, sceneNumber: tl.sceneNumber, timeline: JSON.stringify(tl), componentIssues: null as string | null };
  };
  return { deps, assets, sceneRows, events, submits, stems, polls: () => polls, seedScene };
}
const chars = [{ id: "akira", name: "Akira" }, { id: "mika", name: "Mika" }];

describe("lipSyncStage: honest, video-to-video, never a portrait talking head", () => {
  it("provider NOT configured: no provider call, no LIP_SYNC_CLIP, and the recorded status says exactly why", async () => {
    const h = harness({ configured: false }); const sc = h.seedScene(timeline(1, [["Akira", "Hello there."]]));
    const r = await generateSceneLipSync("p1", [sc], chars, "job", { deps: h.deps });
    expect(h.submits).toHaveLength(0); expect(h.assets.some((a) => a.type === "LIP_SYNC_CLIP")).toBe(false);
    expect(r.applied).toBe(0);
    const issues = JSON.parse(h.sceneRows.sc1.componentIssues);
    expect(issues.find((i: any) => i.component === "lipSync").message).toBe("Lip-sync provider is not configured; the viseme timeline was generated but no mouth animation is applied to the video.");
    expect(h.events.join(" ")).toMatch(/Lip-sync provider is not configured/);
    expect(h.events.join(" ")).not.toMatch(/completed|success/i);
  });
  it("ENABLE_LIPSYNC=false behaves like not configured (nothing sent to the provider)", async () => {
    const h = harness({ enabled: false }); await generateSceneLipSync("p1", [h.seedScene(timeline(1, [["Akira", "Hi."]]))], chars, "job", { deps: h.deps });
    expect(h.submits).toHaveLength(0);
  });
  it("single speaker: sends the ANIMATED CLIP (video) + ONLY that speaker's audio; never a portrait; stores LIP_SYNC_CLIP", async () => {
    const h = harness(); const tl = timeline(1, [["Akira", "One."], ["Akira", "Two."]], "Rain.");
    const r = await generateSceneLipSync("p1", [h.seedScene(tl)], chars, "job", { deps: h.deps });
    expect(h.submits).toHaveLength(1);
    const req = h.submits[0]; expect(req.imageBase64).toBeUndefined(); expect(Buffer.from(req.videoBase64, "base64").toString()).toBe("bytes:clip/1.mp4");
    expect(Buffer.from(req.audioBase64, "base64").toString()).toBe("WAV-STEM-akira");
    expect(h.stems[0]!.speaker).toBe("akira");                       // the narrator's line is NOT what drives the mouth
    const clip = h.assets.find((a) => a.type === "LIP_SYNC_CLIP"); expect(clip.providerName).toBe("test-lipsync"); expect(clip.storageKey).toMatch(/^projects\/p1\/scenes\/1\/lipsync-/);
    expect(r).toMatchObject({ applied: 1, failed: 0 });
    // the ORIGINAL animated clip is kept (composite chooses between them; nothing is replaced)
    expect(h.assets.some((a) => a.type === "VIDEO_CLIP")).toBe(true);
  });
  it("multi-speaker scene: the provider is NOT used (it cannot tell whose face to drive); reason recorded", async () => {
    const h = harness(); const sc = h.seedScene(timeline(1, [["Akira", "Hi."], ["Mika", "Hey."]]));
    await generateSceneLipSync("p1", [sc], chars, "job", { deps: h.deps });
    expect(h.submits).toHaveLength(0);
    expect(JSON.parse(h.sceneRows.sc1.componentIssues).find((i: any) => i.component === "lipSync").message).toMatch(/multi-speaker/i);
  });
  it("layered rigs on every speaker: mouths come from the timeline at render; no provider spend", async () => {
    const h = harness(); const sc = h.seedScene(timeline(1, [["Akira", "Hi."], ["Mika", "Hey."]]));
    const r = await generateSceneLipSync("p1", [sc], [{ id: "akira", name: "Akira", providerMetadata: JSON.stringify({ rig: { mouth: {} } }) }, { id: "mika", name: "Mika", providerMetadata: JSON.stringify({ rig: { mouth: {} } }) }], "job", { deps: h.deps });
    expect(h.submits).toHaveLength(0); expect(r.plans[0]!.mode).toBe("rig"); expect(r.applied).toBe(1);
  });
  it("provider FAILURE is recorded on that scene only; the job does not throw and the plain clip stays in use", async () => {
    const h = harness({ providerBehaviour: "fail" });
    const r = await generateSceneLipSync("p1", [h.seedScene(timeline(1, [["Akira", "Hi."]])), h.seedScene(timeline(2, [["Mika", "Yo."]]))], chars, "job", { deps: h.deps });
    expect(r).toMatchObject({ applied: 0, failed: 2 });
    expect(h.assets.some((a) => a.type === "LIP_SYNC_CLIP")).toBe(false);
    const msg = JSON.parse(h.sceneRows.sc1.componentIssues).find((i: any) => i.code === "LIPSYNC_FAILED").message;
    expect(msg).toMatch(/face not detected/); expect(msg).toMatch(/plain animated clip|un-lip-synced/);
  });
  it("transient submit errors are retried (Retry 1/2)", async () => {
    const h = harness({ providerBehaviour: "flaky" }); const logs: string[] = []; h.deps.log = (l) => logs.push(l);
    const r = await generateSceneLipSync("p1", [h.seedScene(timeline(1, [["Akira", "Hi."]]))], chars, "job", { deps: h.deps });
    expect(r.applied).toBe(1); expect(logs.some((l) => /Retry 1\/2/.test(l))).toBe(true);
  });
  it("a hung provider times out, the job is cancelled at the provider, and the scene is marked failed", async () => {
    const h = harness({ providerBehaviour: "hang" });
    const r = await generateSceneLipSync("p1", [h.seedScene(timeline(1, [["Akira", "Hi."]]))], chars, "job", { deps: h.deps });
    expect(r.failed).toBe(1); expect(h.events).toContain("cancelled");
    expect(JSON.parse(h.sceneRows.sc1.componentIssues).find((i: any) => i.code === "LIPSYNC_FAILED").message).toMatch(/Timed out/);
  });
  it("garbage provider output (fails validation) is rejected, not stored", async () => {
    const h = harness({ validate: { ok: false, durationSeconds: 0, reason: "no video stream" } });
    const r = await generateSceneLipSync("p1", [h.seedScene(timeline(1, [["Akira", "Hi."]]))], chars, "job", { deps: h.deps });
    expect(r.failed).toBe(1); expect(h.assets.some((a) => a.type === "LIP_SYNC_CLIP")).toBe(false);
  });
  it("IDEMPOTENT: an unchanged scene is not sent to the provider again; a changed line is", async () => {
    const h = harness(); const tl = timeline(1, [["Akira", "Stable line."]]);
    const sc = h.seedScene(tl); await generateSceneLipSync("p1", [sc], chars, "job", { deps: h.deps }); expect(h.submits).toHaveLength(1);
    await generateSceneLipSync("p1", [sc], chars, "job", { deps: h.deps }); expect(h.submits).toHaveLength(1);
    const changed = timeline(1, [["Akira", "A different line now."]]); changed.segments[0]!.audio.cacheKey = "new-audio";
    await generateSceneLipSync("p1", [{ ...sc, timeline: JSON.stringify(changed) }], chars, "job", { deps: h.deps }); expect(h.submits).toHaveLength(2);
    expect(h.assets.filter((a) => a.type === "LIP_SYNC_CLIP")).toHaveLength(1);
  });
  it("a stale provider clip is discarded once the scene is no longer a provider scene (e.g. provider removed)", async () => {
    const h = harness(); const sc = h.seedScene(timeline(1, [["Akira", "Hi."]]));
    await generateSceneLipSync("p1", [sc], chars, "job", { deps: h.deps }); expect(h.assets.some((a) => a.type === "LIP_SYNC_CLIP")).toBe(true);
    h.deps.configured = () => false;
    await generateSceneLipSync("p1", [sc], chars, "job", { deps: h.deps }); expect(h.assets.some((a) => a.type === "LIP_SYNC_CLIP")).toBe(false);
  });
  it("rejects provider output that is near-empty, would freeze the mouth (< half the scene), or is absurdly long", async () => {
    for (const durationSeconds of [0.2, 1.0, 40]) {   // near-empty, would freeze the mouth for >half the scene, absurdly long
      const h = harness({ validate: { ok: true, durationSeconds } });
      const r = await generateSceneLipSync("p1", [h.seedScene(timeline(1, [["Akira", "Hi."]]))], chars, "job", { deps: h.deps });
      expect(r.failed).toBe(1); expect(h.assets.some((a) => a.type === "LIP_SYNC_CLIP")).toBe(false);
    }
  });
  it("a longer fixed-length provider clip is accepted (the renderer trims it to the audio-derived scene length)", async () => {
    const h = harness({ validate: { ok: true, durationSeconds: 5.5 } });   // scene is ~2.4 s; a fixed-length provider clip
    expect((await generateSceneLipSync("p1", [h.seedScene(timeline(1, [["Akira", "Hi."]]))], chars, "job", { deps: h.deps })).applied).toBe(1);
  });
  it("narration-only scene: nothing to lip-sync, nothing sent", async () => {
    const h = harness(); await generateSceneLipSync("p1", [h.seedScene(timeline(1, [], "Only narration."))], chars, "job", { deps: h.deps });
    expect(h.submits).toHaveLength(0);
  });
});
