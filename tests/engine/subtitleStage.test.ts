import { describe, it, expect } from "vitest";
import { generateSubtitles } from "../../src/lib/pipeline/subtitleStage";
import type { SubtitleStageDeps } from "../../src/lib/pipeline/subtitleStage";
import { buildSceneTimeline } from "../../src/lib/engine/timeline";
import { planDialogueSegments } from "../../src/lib/engine/dialogue";

const CH = [{ id: "akira", name: "Akira", voice: { provider: "x", voiceId: "a" } }];
const tl = (n: number, text: string, dur: number) => {
  const { segments } = planDialogueSegments({ sceneNumber: n, characters: CH, dialogue: [{ character: "Akira", line: text }] });
  return buildSceneTimeline({ sceneId: `s${n}`, sceneNumber: n, fps: 24, language: "en", onScreen: ["akira"], sceneText: "", sfxHints: [], musicMood: null, isFirstScene: n === 1, plannedSeconds: 3,
    segments: segments.map((planned) => ({ planned, audio: { storageKey: "k", mimeType: "audio/wav", durationSeconds: dur, cacheKey: "c", speechRegions: [{ start: 0.05, end: dur - 0.05 }] } })) });
};
function deps() { const puts: Record<string, string> = {}; const rows: any[] = []; let deleted = 0;
  const d: SubtitleStageDeps = { db: { subtitle: { async deleteMany() { deleted++; rows.length = 0; }, async create({ data }: any) { rows.push(data); } } }, store: { async put(k, b) { puts[k] = b.toString(); }, key: (p, ...x) => `${p}/${x.join("/")}` } };
  return { d, puts, rows, deleted: () => deleted }; }

describe("generateSubtitles", () => {
  it("uses the exact measured windows from the master timelines (scene offsets accumulate frame-exact durations)", async () => {
    const a = tl(1, "First line.", 1.5), b = tl(2, "Second line.", 2.0); const h = deps();
    await generateSubtitles("p", "en", [{ sceneNumber: 1, narration: null, dialogue: null, estimatedSeconds: 99, timeline: JSON.stringify(a) }, { sceneNumber: 2, narration: null, dialogue: null, estimatedSeconds: 99, timeline: JSON.stringify(b) }], h.d);
    const srt = h.puts["p/subtitles/en.srt"]!;
    const t = (x: number) => new Date(Math.round(x * 1000)).toISOString().slice(11, 23).replace(".", ",");
    expect(srt).toContain(`${t(a.segments[0]!.startTime)} --> ${t(a.segments[0]!.endTime)}`);
    expect(srt).toContain(`${t(a.duration + b.segments[0]!.startTime)} --> ${t(a.duration + b.segments[0]!.endTime)}`);   // NOT based on the "99 s estimate"
    expect(srt).toContain("Akira: Second line.");
  });
  it("falls back to estimated timing only for projects without timelines", async () => {
    const h = deps();
    await generateSubtitles("p", "en", [{ sceneNumber: 1, narration: "Hello.", dialogue: null, estimatedSeconds: 4, timeline: null }], h.d);
    expect(h.puts["p/subtitles/en.srt"]).toContain("00:00:00,000 --> 00:00:04,000");
  });
  it("regeneration REPLACES the stored subtitle row (no stale duplicates)", async () => {
    const h = deps(); const scene = { sceneNumber: 1, narration: "Hi.", dialogue: null, estimatedSeconds: 3, timeline: null };
    await generateSubtitles("p", "en", [scene], h.d); await generateSubtitles("p", "en", [scene], h.d);
    expect(h.rows).toHaveLength(1); expect(h.deleted()).toBe(2);
  });
});
