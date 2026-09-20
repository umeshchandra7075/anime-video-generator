import { describe, it, expect } from "vitest";
import { planSceneLipSync } from "../../src/lib/engine/lipsyncPlan";
import { buildSrt, srtTime } from "../../src/lib/engine/srt";
import { buildSceneTimeline } from "../../src/lib/engine/timeline";
import { planDialogueSegments } from "../../src/lib/engine/dialogue";

const chars = [{ id: "akira", name: "Akira", voice: { provider: "x", voiceId: "a" } }, { id: "mika", name: "Mika", voice: { provider: "x", voiceId: "m" } }];
function tl(n: number, lines: Array<[string, string, number]>, narration?: string) {
  const { segments } = planDialogueSegments({ sceneNumber: n, characters: chars, narration, narratorVoice: { provider: "x", voiceId: "n" }, dialogue: lines.map(([character, line]) => ({ character, line })) });
  const durs = [...(narration ? [1.5] : []), ...lines.map((l) => l[2])];
  return buildSceneTimeline({ sceneId: `s${n}`, sceneNumber: n, fps: 24, language: "en", onScreen: ["akira", "mika"], sceneText: "", sfxHints: [], musicMood: null, isFirstScene: n === 1, plannedSeconds: 3,
    segments: segments.map((planned, i) => ({ planned, audio: { storageKey: "k", mimeType: "audio/wav", durationSeconds: durs[i]!, cacheKey: "c", speechRegions: [{ start: 0.05, end: durs[i]! - 0.05 }] } })) });
}
const base = { providerConfigured: false, hasVideoClip: true, rigCharacterIds: [] as string[] };

describe("lip-sync mode planning is honest about what reaches the video", () => {
  const single = tl(1, [["Akira", "Hello there.", 1.5]]), duo = tl(2, [["Akira", "Hi.", 1], ["Mika", "Hey.", 1]]);
  it("no speaker -> none", () => expect(planSceneLipSync(tl(3, []), base).mode).toBe("none"));
  it("narrator-only -> none (a narrator has no on-screen mouth)", () => expect(planSceneLipSync(tl(3, [], "Once upon a time."), base).mode).toBe("none"));
  it("provider missing -> visemes-only, appliedToVideo=false, and says the provider is not configured", () => {
    const p = planSceneLipSync(single, base);
    expect(p.mode).toBe("visemes-only"); expect(p.appliedToVideo).toBe(false); expect(p.reason).toBe("Lip-sync provider is not configured; the viseme timeline was generated but no mouth animation is applied to the video.");
  });
  it("single speaker + provider + animated clip -> provider video-to-video (never a portrait talking head)", () => {
    const p = planSceneLipSync(single, { ...base, providerConfigured: true });
    expect(p.mode).toBe("provider-video"); expect(p.appliedToVideo).toBe(true); expect(p.reason).toMatch(/video-to-video/);
  });
  it("multi-speaker + provider, no rigs -> skipped with an explanation (does not re-drive the wrong face)", () => {
    const p = planSceneLipSync(duo, { ...base, providerConfigured: true });
    expect(p.mode).toBe("visemes-only"); expect(p.appliedToVideo).toBe(false); expect(p.reason).toMatch(/multi-speaker/i);
  });
  it("all speakers rigged -> rig compositing, regardless of provider", () => {
    const p = planSceneLipSync(duo, { ...base, rigCharacterIds: ["akira", "mika"] });
    expect(p.mode).toBe("rig"); expect(p.appliedToVideo).toBe(true);
  });
  it("only some speakers rigged -> not 'rig'", () => expect(planSceneLipSync(duo, { ...base, rigCharacterIds: ["akira"] }).mode).toBe("visemes-only"));
  it("reports the timing quality that will drive the mouth", () => expect(planSceneLipSync(single, base).visemeQuality).toEqual(["audio-aligned"]));
});

describe("subtitles use the exact measured windows", () => {
  it("formats SRT timestamps", () => { expect(srtTime(0)).toBe("00:00:00,000"); expect(srtTime(3723.456)).toBe("01:02:03,456"); });
  it("cue times = scene offset + segment window; speaker prefix except narrator; contiguous scenes", () => {
    const a = tl(1, [["Akira", "Where are you going?", 2.4]], "Rain.");
    const b = tl(2, [["Mika", "Out.", 1]]);
    const srt = buildSrt([a, b]).split("\n\n");
    expect(srt).toHaveLength(3);
    const first = srt[0]!.split("\n"), third = srt[2]!.split("\n");
    expect(first[2]).toBe("Rain.");
    expect(first[1]).toBe(`${srtTime(a.segments[0]!.startTime)} --> ${srtTime(a.segments[0]!.endTime)}`);
    expect(srt[1]!).toContain("Akira: Where are you going?");
    expect(third[1]).toBe(`${srtTime(a.duration + b.segments[0]!.startTime)} --> ${srtTime(a.duration + b.segments[0]!.endTime)}`);
  });
});
