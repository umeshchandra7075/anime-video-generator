import { describe, it, expect } from "vitest";
import { planDialogueSegments } from "../../src/lib/engine/dialogue";
import type { CharacterInfo } from "../../src/lib/engine/dialogue";
import { buildSceneTimeline, validateTimeline, timelineHash } from "../../src/lib/engine/timeline";
import type { TimelineInput } from "../../src/lib/engine/timeline";
import { classifySfx, planSfx } from "../../src/lib/engine/sfx";
import { planCamera } from "../../src/lib/engine/camera";
import type { SegmentAudio } from "../../src/lib/engine/types";

const chars: CharacterInfo[] = [
  { id: "akira", name: "Akira", voice: { provider: "elevenlabs", voiceId: "va" } },
  { id: "mika", name: "Mika", voice: { provider: "elevenlabs", voiceId: "vm" } },
  { id: "ren", name: "Ren", voice: { provider: "elevenlabs", voiceId: "vr" } },
];
const audio = (d: number, id = "x"): SegmentAudio => ({ storageKey: `k/${id}.mp3`, mimeType: "audio/mpeg", durationSeconds: d, cacheKey: id, speechRegions: [{ start: 0.05, end: d - 0.05 }] });

function scene(lines: Array<[string, string, number, string?]>, extra: Partial<TimelineInput> = {}): TimelineInput {
  const { segments } = planDialogueSegments({ sceneNumber: 1, characters: chars, dialogue: lines.map(([character, line, , emotion]) => ({ character, line, emotion })) });
  return { sceneId: "scene_001", sceneNumber: 1, fps: 24, language: "en", onScreen: ["akira", "mika"], plannedSeconds: 8, sceneText: "two friends talk", sfxHints: [], musicMood: null, isFirstScene: false,
    segments: segments.map((planned, i) => ({ planned, audio: audio(lines[i]![2], planned.segmentId) })), ...extra };
}

describe("master timeline - audio first", () => {
  const lines: Array<[string, string, number, string?]> = [["Akira", "Where are you going?", 2.4, "serious"], ["Mika", "Somewhere you cannot follow.", 2.3, "sad"], ["Akira", "Wait for me!", 1.4, "angry"]];
  it("places segments sequentially from MEASURED durations (A, B, A) with no overlap, and is internally consistent", () => {
    const tl = buildSceneTimeline(scene(lines));
    expect(tl.segments.map((s) => s.characterId)).toEqual(["akira", "mika", "akira"]);
    tl.segments.forEach((s, i) => { expect(s.duration).toBe(lines[i]![2]); expect(s.endTime - s.startTime).toBeCloseTo(lines[i]![2], 2); });
    for (let i = 1; i < 3; i++) expect(tl.segments[i]!.startTime).toBeGreaterThanOrEqual(tl.segments[i - 1]!.endTime);
    expect(validateTimeline(tl)).toEqual([]);
    expect(tl.durationSource).toBe("audio");
  });
  it("a 6.83 s line is never truncated: the scene grows to fit it (planned 4 s is ignored for dialogue scenes)", () => {
    const tl = buildSceneTimeline(scene([["Akira", "A very long speech.", 6.83]], { plannedSeconds: 4 }));
    expect(tl.segments[0]!.duration).toBe(6.83);
    expect(tl.duration).toBeGreaterThanOrEqual(tl.segments[0]!.endTime);
    expect(tl.duration).toBeGreaterThan(6.83);
  });
  it("tail after the final line keeps the characters visible (>= 0.6 s), first line has a lead-in", () => {
    const tl = buildSceneTimeline(scene(lines));
    expect(tl.duration - tl.segments[2]!.endTime).toBeGreaterThanOrEqual(0.6 - 0.005);
    expect(tl.segments[0]!.startTime).toBeGreaterThanOrEqual(0.3);
  });
  it("silent scenes use the planned duration and say so", () => {
    const tl = buildSceneTimeline(scene([], { plannedSeconds: 6, onScreen: ["akira"] }));
    expect(tl.durationSource).toBe("planned"); expect(tl.duration).toBe(6); expect(validateTimeline(tl)).toEqual([]);
  });
  it("is fully deterministic (identical hash on rebuild)", () => {
    expect(timelineHash(buildSceneTimeline(scene(lines)))).toBe(timelineHash(buildSceneTimeline(scene(lines))));
  });
  it("validateTimeline catches overlaps, a moved segment, and out-of-scene SFX", () => {
    const tl = buildSceneTimeline(scene(lines));
    const bad = JSON.parse(JSON.stringify(tl)); bad.segments[1].startTime = bad.segments[0].endTime - 0.5;
    expect(validateTimeline(bad).join(" ")).toMatch(/overlaps|window/);
    const bad2 = JSON.parse(JSON.stringify(tl)); bad2.sfx.push({ sfxId: "z", type: "door", startTime: tl.duration + 1, duration: 0.5, volume: 1, source: "procedural", ref: "", priority: 1, loop: false });
    expect(validateTimeline(bad2).join(" ")).toMatch(/outside the scene/);
  });
});

describe("actors stay alive", () => {
  const lines: Array<[string, string, number, string?]> = [["Akira", "Get out of my sight!", 2.5, "angry"], ["Mika", "No.", 1.0, "calm"], ["Akira", "Fine.", 1.0, "serious"]];
  const tl = buildSceneTimeline(scene(lines));
  it("each speaker is TALKING exactly during their own lines and LISTENING during the other's", () => {
    const akira = tl.actors.find((a) => a.characterId === "akira")!, mika = tl.actors.find((a) => a.characterId === "mika")!;
    const stateAt = (a: typeof akira, t: number) => a.spans.find((s) => t >= s.start && t < s.end)!.state;
    const s0 = tl.segments[0]!, s1 = tl.segments[1]!;
    expect(stateAt(akira, (s0.startTime + s0.endTime) / 2)).toBe("TALKING");
    expect(stateAt(mika, (s0.startTime + s0.endTime) / 2)).toBe("LISTENING");
    expect(stateAt(mika, (s1.startTime + s1.endTime) / 2)).toBe("TALKING");
    expect(stateAt(akira, (s1.startTime + s1.endTime) / 2)).toBe("LISTENING");
  });
  it("a listener's face shows a subdued reaction WHILE an intense line is spoken", () => {
    const mika = tl.actors.find((a) => a.characterId === "mika")!;
    const during = mika.spans.find((s) => s.state === "LISTENING" && s.start <= tl.segments[0]!.startTime + 0.01)!;
    expect(during.expression).toBe("nervous");
    expect(mika.events.some((e) => e.kind === "expression" && e.params!.to === "nervous")).toBe(true);
  });
  it("after a line with a real pause, the listener gets a REACTION span mapped from the speaker's emotion", () => {
    const t2 = buildSceneTimeline(scene([["Akira", "You did WHAT?!", 1.5, "surprised"], ["Mika", "Nothing.", 1]]));
    const mika = t2.actors.find((a) => a.characterId === "mika")!;
    const r = mika.spans.find((s) => s.state === "REACTION")!;
    expect(r).toBeDefined(); expect(r.expression).toBe("surprised");
    expect(r.start).toBeGreaterThanOrEqual(t2.segments[0]!.endTime - 0.01); expect(r.end).toBeLessThanOrEqual(t2.segments[1]!.startTime + 0.01);
    expect(validateTimeline(t2)).toEqual([]);
  });
  it("listeners get gaze events toward the speaker; everyone blinks and breathes; no character is frozen", () => {
    for (const a of tl.actors) {
      expect(a.events.some((e) => e.kind === "blink")).toBe(true);
      expect(a.events.some((e) => e.kind === "breathe")).toBe(true);
    }
    const mika = tl.actors.find((a) => a.characterId === "mika")!;
    expect(mika.events.find((e) => e.kind === "gaze")!.params!.target).toBe("akira");
  });
  it("emotion drives the speaker's expression and gesture style", () => {
    const akira = tl.actors.find((a) => a.characterId === "akira")!;
    expect(akira.spans.find((s) => s.state === "TALKING")!.expression).toBe("angry");
    const g = akira.events.find((e) => e.kind === "gesture");
    expect(g!.params!.style).toBe("aggressive");
  });
  it("blink timing is seeded per (scene, character): stable across rebuilds, different between characters", () => {
    const again = buildSceneTimeline(scene(lines));
    const blinks = (t: typeof tl, id: string) => t.actors.find((a) => a.characterId === id)!.events.filter((e) => e.kind === "blink").map((e) => e.start);
    expect(blinks(again, "akira")).toEqual(blinks(tl, "akira"));
    expect(blinks(tl, "akira")).not.toEqual(blinks(tl, "mika"));
  });
  it("three characters: only the speaker is TALKING at any instant", () => {
    const t3 = buildSceneTimeline(scene([["Ren", "Hey.", 1], ["Akira", "Hm.", 1], ["Mika", "Stop.", 1]], { onScreen: ["akira", "mika", "ren"] }));
    for (const seg of t3.segments) {
      const mid = (seg.startTime + seg.endTime) / 2;
      const talking = t3.actors.filter((a) => a.spans.find((s) => mid >= s.start && mid < s.end)!.state === "TALKING").map((a) => a.characterId);
      expect(talking).toEqual([seg.characterId]);
    }
  });
});

describe("SFX planning", () => {
  it("classifies hints", () => {
    expect(classifySfx("sword clashing")).toBe("sword"); expect(classifySfx("distant thunder")).toBe("thunder");
    expect(classifySfx("heavy rain on window")).toBe("rain"); expect(classifySfx("door slams shut")).toBe("door");
    expect(classifySfx("soft piano")).toBeNull();
  });
  it("ambient beds span the scene; one-shots are placed inside it with type/start/duration/volume/source/ref/priority", () => {
    const ev = planSfx(["rain", "thunder", "footsteps", "door slam"], { sceneNumber: 2, duration: 8, segments: [{ start: 0.35, end: 3 }] });
    const rain = ev.find((e) => e.type === "rain")!;
    expect(rain.loop).toBe(true); expect(rain.startTime).toBe(0); expect(rain.duration).toBe(8);
    for (const e of ev) { expect(e.startTime + e.duration).toBeLessThanOrEqual(8.001); for (const k of ["sfxId", "type", "startTime", "duration", "volume", "source", "ref", "priority"] as const) expect(e[k]).toBeDefined(); }
    expect(ev.filter((e) => e.type === "footstep").length).toBeGreaterThanOrEqual(2);
    expect(new Set(ev.map((e) => e.sfxId)).size).toBe(ev.length);
  });
  it("a one-shot whose anchor would cover a spoken line's onset is moved into the nearest dialogue gap", () => {
    const segs = [{ start: 0.1, end: 2 }, { start: 2.6, end: 4 }];           // lead-in (0.1 s) is too short to count; gaps: [2,2.6] and [4,8]
    const e = planSfx(["door slams shut"], { sceneNumber: 1, duration: 8, segments: segs })[0]!;
    expect(e.startTime).toBeGreaterThanOrEqual(2); expect(e.startTime).toBeLessThan(2.6);      // anchor 0.3 -> nearest gap start
    expect(segs.some((s) => e.startTime >= s.start && e.startTime < s.end)).toBe(false);
  });
  it("with NO gap available the one-shot keeps its anchor and is attenuated", () => {
    const segs = [{ start: 0, end: 3.9 }, { start: 4.0, end: 8 }];
    const over = planSfx(["door"], { sceneNumber: 1, duration: 8, segments: segs })[0]!;
    const clear = planSfx(["door"], { sceneNumber: 1, duration: 8, segments: [] })[0]!;
    expect(over.volume).toBeLessThan(clear.volume);
  });
  it("two impacts are never stacked on the same instant (sword + impact in a dialogue-dense scene)", () => {
    const ev = planSfx(["sword clash", "heavy impact"], { sceneNumber: 3, duration: 3.04, segments: [{ start: 0.35, end: 2.43 }] });
    expect(ev).toHaveLength(2);
    expect(Math.abs(ev[0]!.startTime - ev[1]!.startTime)).toBeGreaterThanOrEqual(0.4);
    for (const e of ev) expect(e.startTime + e.duration).toBeLessThanOrEqual(3.041);
  });
  it("never schedules a one-shot past the end of the scene", () => {
    for (const ev of planSfx(["thunder", "explosion", "door"], { sceneNumber: 1, duration: 2.5, segments: [{ start: 0.3, end: 2.4 }] })) expect(ev.startTime + ev.duration).toBeLessThanOrEqual(2.501);
  });
});

describe("camera planning is contextual and deterministic", () => {
  const base = { duration: 6, segments: [] as never[], onScreen: ["akira", "mika"], sceneText: "", sfxTypes: [] as never[], isFirstScene: false };
  const seg = (id: string, s: number, e: number, emotion: never, intensity = 0.6) => ({ characterId: id, start: s, end: e, emotion, intensity });
  it("establishing shot -> WIDE with a slow zoom-out", () => {
    const p = planCamera({ ...base, isFirstScene: true, sceneText: "city skyline at dawn" });
    expect(p.shot).toBe("WIDE"); expect(p.moves[0]!.type).toBe("zoomOut"); expect(p.reason).toBe("establishing");
  });
  it("emotional dialogue -> slow CLOSEUP push-in", () => {
    const p = planCamera({ ...base, segments: [seg("mika", 0.4, 4, "sad" as never, 0.7)] });
    expect(p.shot).toBe("CLOSEUP"); expect(p.moves[0]!.type).toBe("zoomIn"); expect(p.moves[0]!.end).toBe(6);
  });
  it("angry dialogue -> gradual push-in", () => {
    const p = planCamera({ ...base, segments: [seg("akira", 0.4, 3, "angry" as never, 0.7), seg("mika", 3.2, 5, "calm" as never, 0.3)] });
    expect(p.reason).toBe("confrontation"); expect(p.moves[0]!.amount).toBeGreaterThan(p.baseZoom);
  });
  it("action -> DYNAMIC with a shake exactly at each impact SFX", () => {
    const p = planCamera({ ...base, sceneText: "the duel begins", sfxTypes: [{ type: "sword", startTime: 2.1 }, { type: "impact", startTime: 4 }] });
    expect(p.shot).toBe("DYNAMIC");
    expect(p.moves.filter((m) => m.type === "shake").map((m) => m.start)).toEqual([2.1, 4]);
  });
  it("calm two-person conversation -> TWO_SHOT, camera moves only when the SPEAKER changes", () => {
    const p = planCamera({ ...base, segments: [seg("akira", 0.4, 2, "calm" as never, 0.3), seg("akira", 2.2, 3, "calm" as never, 0.3), seg("mika", 3.2, 5, "calm" as never, 0.3)] });
    expect(p.shot).toBe("TWO_SHOT");
    expect(p.moves.filter((m) => m.type === "focusTransition")).toHaveLength(2);
  });
  it("same input -> identical plan; every move lies inside the scene", () => {
    const ctx = { ...base, sceneText: "fight", sfxTypes: [{ type: "sword" as const, startTime: 5.95 }] };
    expect(planCamera(ctx)).toEqual(planCamera(ctx));
    for (const m of planCamera(ctx).moves) { expect(m.start).toBeGreaterThanOrEqual(0); expect(m.end).toBeLessThanOrEqual(6.001); }
  });
});
