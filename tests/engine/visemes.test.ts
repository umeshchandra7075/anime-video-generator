import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { synthVoice, writeWav, tmpDir, rmDir } from "./fixtures";
import { analyzeSpeechAudio } from "../../src/lib/engine/audioAnalysis";
import { textToWordUnits, languageSupport } from "../../src/lib/engine/g2p";
import { buildVisemeTrack, visemeAt, finalizeIntervals } from "../../src/lib/engine/visemes";
import { VISEMES } from "../../src/lib/engine/types";
import type { Viseme } from "../../src/lib/engine/types";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmDir(dirs.pop()!); });
function wav(name: string, duration: number, words: Array<{ start: number; end: number }>, extra: Record<string, unknown> = {}) {
  const d = tmpDir(); dirs.push(d);
  return writeWav(path.join(d, name), synthVoice({ duration, words, ...extra }));
}
const visemesOf = (text: string, lang = "en") => textToWordUnits(text, lang).words.flatMap((w) => w.units.map((u) => u.viseme));
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

describe("audio analysis measures real audio", () => {
  it("duration = decoded samples / rate (not an estimate) and speech edges are within 40 ms", async () => {
    const f = wav("a.wav", 2.35, [{ start: 0.31, end: 1.2 }, { start: 1.62, end: 2.05 }]);
    const a = await analyzeSpeechAudio(f);
    expect(a.durationSeconds).toBeCloseTo(2.35, 2);
    expect(a.speechRegions).toHaveLength(2);
    expect(near(a.speechRegions[0]!.start, 0.31, 0.04)).toBe(true);
    expect(near(a.speechRegions[0]!.end, 1.2, 0.05)).toBe(true);
    expect(near(a.speechRegions[1]!.start, 1.62, 0.04)).toBe(true);
    expect(near(a.speechRegions[1]!.end, 2.05, 0.05)).toBe(true);
  });
  it("does not split a word at a 50 ms dip, but does split at a 250 ms pause", async () => {
    const f = wav("b.wav", 2.0, [{ start: 0.2, end: 0.7 }, { start: 0.75, end: 1.2 }, { start: 1.45, end: 1.9 }]);
    const a = await analyzeSpeechAudio(f);
    expect(a.speechRegions).toHaveLength(2);
  });
  it("all-silent audio has no speech regions", async () => {
    const f = wav("c.wav", 1.0, []);
    expect((await analyzeSpeechAudio(f)).speechRegions).toHaveLength(0);
  });
});

describe("grapheme -> viseme rules", () => {
  it("maps characteristic English onsets to the right mouth shapes", () => {
    expect(visemesOf("map")[0]).toBe("MBP");
    expect(visemesOf("the")[0]).toBe("TH");
    expect(visemesOf("ship")[0]).toBe("CHJ");
    expect(visemesOf("five")[0]).toBe("FV");
    expect(visemesOf("queen")[0]).toBe("WQ");
    expect(visemesOf("cat")[0]).toBe("KG");
    expect(visemesOf("sun")[0]).toBe("SZ");
    expect(visemesOf("phone")[0]).toBe("FV");
    expect(visemesOf("knight")[0]).toBe("TD"); // silent k
  });
  it("silent final e adds no unit; digraphs consume both letters", () => {
    expect(visemesOf("make")).toEqual(["MBP", "AE", "KG"]);
    expect(visemesOf("shh")).toEqual(["CHJ"]);
  });
  it("only ever emits the 16 defined visemes", () => {
    const all = visemesOf("The quick brown fox jumps over the lazy dog. Quixotic zephyrs whisper through night.");
    for (const v of all) expect((VISEMES as readonly string[]).includes(v)).toBe(true);
    expect(new Set(all).size).toBeGreaterThan(8);
  });
  it("Japanese kana (hiragana + katakana + small ya/yu/yo + long vowel) maps via romaji", () => {
    const v = visemesOf("こんにちは", "ja");
    expect(v[0]).toBe("KG"); expect(v).toContain("MBP"); expect(v).toContain("CHJ"); expect(v).toContain("OH");
    expect(visemesOf("カー", "ja").slice(0, 2)).toEqual(["KG", "AA"]);
    expect(visemesOf("きょう", "ja")[0]).toBe("KG");
  });
  it("reports unsupported for scripts without rules (kanji, Korean, Hindi ...) instead of guessing", () => {
    expect(languageSupport("ja", "私は行く")).toBe("unsupported");
    expect(languageSupport("ko", "안녕하세요")).toBe("unsupported");
    expect(languageSupport("hi", "नमस्ते")).toBe("unsupported");
    expect(languageSupport("en", "Hello")).toBe("full");
  });
});

describe("viseme timeline follows the AUDIO", () => {
  const words = [{ start: 0.2, end: 0.5 }, { start: 0.75, end: 0.95 }, { start: 1.15, end: 1.65 }]; // "map" "the" "ship" with real pauses
  it("audio-aligned: rest in silence, speech visemes only inside speech, words land in their windows", async () => {
    const a = await analyzeSpeechAudio(wav("d.wav", 1.9, words));
    const t = buildVisemeTrack({ segmentId: "s1", characterId: "c", text: "map the ship", language: "en", segmentStart: 0, duration: a.durationSeconds, speechRegions: a.speechRegions, envelope: a.envelope, fps: 24 });
    expect(t.quality).toBe("audio-aligned");
    const nonRest = t.intervals.filter((i) => i.viseme !== "REST");
    expect(near(nonRest[0]!.start, 0.2, 0.06)).toBe(true);
    expect(near(nonRest[nonRest.length - 1]!.end, 1.65, 0.08)).toBe(true);
    const first = (v: Viseme) => t.intervals.find((i) => i.viseme === v)!;
    expect(first("MBP").start).toBeGreaterThanOrEqual(0.15); expect(first("MBP").start).toBeLessThan(0.5);
    expect(first("TH").start).toBeGreaterThanOrEqual(0.7); expect(first("TH").end).toBeLessThanOrEqual(1.0);
    expect(first("CHJ").start).toBeGreaterThanOrEqual(1.1); expect(first("CHJ").end).toBeLessThanOrEqual(1.7);
    for (const tt of [0.05, 0.6, 1.05, 1.8]) expect(visemeAt(t, tt)).toBe("REST");
  });
  it("contiguous, non-overlapping coverage of exactly [0,duration], offset into scene time", async () => {
    const a = await analyzeSpeechAudio(wav("e.wav", 1.9, words));
    const t = buildVisemeTrack({ segmentId: "s1", characterId: "c", text: "map the ship", language: "en", segmentStart: 3.0, duration: a.durationSeconds, speechRegions: a.speechRegions, envelope: a.envelope, fps: 24 });
    expect(t.intervals[0]!.start).toBeCloseTo(3.0, 3);
    expect(t.intervals[t.intervals.length - 1]!.end).toBeCloseTo(3.0 + a.durationSeconds, 2);
    for (let i = 1; i < t.intervals.length; i++) expect(t.intervals[i]!.start).toBeCloseTo(t.intervals[i - 1]!.end, 3);
    expect(visemeAt(t, 3.0 + 0.3)).not.toBe("REST");
  });
  it("no sub-frame flicker (except deliberate lip closures) and no adjacent duplicates", async () => {
    const a = await analyzeSpeechAudio(wav("f.wav", 1.9, words));
    const t = buildVisemeTrack({ segmentId: "s1", characterId: "c", text: "map the ship and a very long unnatural sentence", language: "en", segmentStart: 0, duration: a.durationSeconds, speechRegions: a.speechRegions, envelope: a.envelope, fps: 24 });
    for (let i = 0; i < t.intervals.length; i++) {
      const iv = t.intervals[i]!;
      const closure = iv.viseme === "MBP" || iv.viseme === "FV";
      expect(iv.end - iv.start).toBeGreaterThanOrEqual((closure ? 0.6 : 1) / 24 - 0.002);
      if (i > 0) expect(iv.viseme).not.toBe(t.intervals[i - 1]!.viseme);
    }
  });
  it("is deterministic", async () => {
    const a = await analyzeSpeechAudio(wav("g.wav", 1.9, words));
    const mk = () => buildVisemeTrack({ segmentId: "s1", characterId: "c", text: "map the ship", language: "en", segmentStart: 0, duration: a.durationSeconds, speechRegions: a.speechRegions, envelope: a.envelope, fps: 24 });
    expect(mk()).toEqual(mk());
  });
  it("provider character timestamps take precedence and place words exactly", () => {
    const text = "map the ship";
    const chars = [...text];
    const wordSpan = (w: [number, number]) => w;
    const spans: Record<number, [number, number]> = {}; // char index -> [start,end]
    const put = (from: number, to: number, t0: number, t1: number) => { for (let i = from; i < to; i++) { const step = (t1 - t0) / (to - from); spans[i] = wordSpan([t0 + (i - from) * step, t0 + (i - from + 1) * step]); } };
    put(0, 3, 0.2, 0.5); put(3, 4, 0.5, 0.75); put(4, 7, 0.75, 0.95); put(7, 8, 0.95, 1.15); put(8, 12, 1.15, 1.65);
    const al = { characters: chars, startTimes: chars.map((_, i) => spans[i]![0]), endTimes: chars.map((_, i) => spans[i]![1]) };
    const t = buildVisemeTrack({ segmentId: "s", characterId: "c", text, language: "en", segmentStart: 0, duration: 1.9, speechRegions: [{ start: 0.15, end: 1.7 }], alignment: al, fps: 24 });
    expect(t.quality).toBe("provider-alignment");
    expect(t.intervals.find((i) => i.viseme === "TH")!.start).toBeGreaterThanOrEqual(0.74);
    expect(t.intervals.find((i) => i.viseme === "CHJ")!.start).toBeGreaterThanOrEqual(1.14);
  });
  it("a mismatching alignment is refused (falls back), never misapplied", () => {
    const al = { characters: [..."other text"], startTimes: [...Array(10).keys()].map((i) => i * 0.1), endTimes: [...Array(10).keys()].map((i) => i * 0.1 + 0.1) };
    const t = buildVisemeTrack({ segmentId: "s", characterId: "c", text: "map the ship", language: "en", segmentStart: 0, duration: 1.9, speechRegions: [{ start: 0.2, end: 1.6 }], alignment: al, fps: 24 });
    expect(t.quality).toBe("audio-aligned");
  });
  it("the silent-e rule does not delete the only vowel of short words (the/she/be)", () => {
    expect(visemesOf("the")).toEqual(["TH", "EH"]);
    expect(visemesOf("she")).toEqual(["CHJ", "EH"]);
    expect(visemesOf("home")).toEqual(["OH", "MBP"]); // leading h skipped, final e silent
  });
  it("word boundaries pick the RIGHT pause even when weights are off (monotone assignment)", async () => {
    // long word then two short ones: greedy nearest-gap snapping would mis-assign here
    const w = [{ start: 0.2, end: 0.9 }, { start: 1.1, end: 1.25 }, { start: 1.45, end: 1.6 }];
    const a = await analyzeSpeechAudio(wav("i.wav", 1.9, w));
    const t = buildVisemeTrack({ segmentId: "s", characterId: "c", text: "banana it be", language: "en", segmentStart: 0, duration: a.durationSeconds, speechRegions: a.speechRegions, envelope: a.envelope, fps: 24 });
    // "it" must sit in its own window (1.1-1.25), "be" in the last one
    expect(visemeAt(t, 1.18)).toBe("IH");
    expect(visemeAt(t, 1.4)).toBe("REST");
    expect(["MBP", "EH"].includes(visemeAt(t, 1.5))).toBe(true);
  });
  it("silent audio => the mouth stays at REST for the whole segment", () => {
    const t = buildVisemeTrack({ segmentId: "s", characterId: "c", text: "hello there", language: "en", segmentStart: 0, duration: 1.0, speechRegions: [], fps: 24 });
    expect(t.intervals.every((i) => i.viseme === "REST")).toBe(true);
  });
  it("unsupported language falls back to amplitude-driven syllable mouth shapes, labelled energy-only", async () => {
    const syll = [0.2, 0.5, 0.8, 1.1].map((s) => ({ start: s, end: s + 0.22 }));
    const a = await analyzeSpeechAudio(wav("h.wav", 1.6, syll));
    const t = buildVisemeTrack({ segmentId: "s", characterId: "c", text: "안녕하세요", language: "ko", segmentStart: 0, duration: a.durationSeconds, speechRegions: a.speechRegions, envelope: a.envelope, fps: 24 });
    expect(t.quality).toBe("energy-only");
    expect(t.intervals.filter((i) => ["AA", "EH", "OH"].includes(i.viseme)).length).toBeGreaterThanOrEqual(3); // one open shape per syllable burst
    expect(visemeAt(t, 0.05)).toBe("REST"); expect(visemeAt(t, 1.5)).toBe("REST");
  });
  it("finalizeIntervals fills gaps with REST and merges duplicates", () => {
    const r = finalizeIntervals([{ start: 0.2, end: 0.4, viseme: "AA" }, { start: 0.4, end: 0.6, viseme: "AA" }], 1, 1 / 24);
    expect(r).toEqual([{ start: 0, end: 0.2, viseme: "REST" }, { start: 0.2, end: 0.6, viseme: "AA" }, { start: 0.6, end: 1, viseme: "REST" }]);
  });
});
