import { describe, it, expect } from "vitest";
import { planDialogueSegments, resolveSpeaker, castVoices, splitLongText } from "../../src/lib/engine/dialogue";
import { buildEmotionProfile, mapEmotionToVoiceParams, normalizeEmotion, resolveEmotion, applyPronunciation } from "../../src/lib/engine/emotion";
import { EMOTIONS } from "../../src/lib/engine/types";
import type { CharacterInfo } from "../../src/lib/engine/dialogue";

const akira: CharacterInfo = { id: "c_akira", name: "Akira", gender: "male", voice: { provider: "elevenlabs", voiceId: "voice_akira_001" }, defaultEmotion: "serious" };
const mika: CharacterInfo = { id: "c_mika", name: "Mika Sato", gender: "female", voice: { provider: "elevenlabs", voiceId: "voice_mika_001" } };
const ren: CharacterInfo = { id: "c_ren", name: "Ren", gender: "male", voice: { provider: "elevenlabs", voiceId: "voice_ren_001" } };

describe("planDialogueSegments - multi-character dialogue", () => {
  it("one-character scene: one segment bound to that character's voice", () => {
    const { segments, issues } = planDialogueSegments({ sceneNumber: 1, dialogue: [{ character: "Akira", line: "Where are you going?" }], characters: [akira] });
    expect(segments).toHaveLength(1);
    expect(segments[0]!.characterId).toBe("c_akira");
    expect(segments[0]!.voice!.voiceId).toBe("voice_akira_001");
    expect(segments[0]!.segmentId).toBe("dlg_001_001");
    expect(issues).toEqual([]);
  });
  it("two-character scene: every line uses ITS speaker's voice, in script order", () => {
    const { segments } = planDialogueSegments({ sceneNumber: 2, characters: [akira, mika], dialogue: [
      { character: "Akira", line: "Where are you going?" }, { character: "Mika", line: "Somewhere you can't follow." }, { character: "Akira", line: "Wait!" } ] });
    expect(segments.map((s) => s.voice!.voiceId)).toEqual(["voice_akira_001", "voice_mika_001", "voice_akira_001"]);
    expect(segments.map((s) => s.characterId)).toEqual(["c_akira", "c_mika", "c_akira"]);
  });
  it("three-character scene keeps three distinct voices", () => {
    const { segments, issues } = planDialogueSegments({ sceneNumber: 3, characters: [akira, mika, ren], dialogue: [
      { character: "Ren", line: "Hey." }, { character: "Akira", line: "Hm." }, { character: "Mika", line: "Stop it." }, { character: "Ren", line: "Fine." } ] });
    expect(new Set(segments.map((s) => s.voice!.voiceId)).size).toBe(3);
    expect(issues.filter((i) => i.code === "SHARED_VOICE")).toEqual([]);
  });
  it("narration becomes its own narrator segment first, with the narrator voice - never a character's", () => {
    const { segments } = planDialogueSegments({ sceneNumber: 1, narration: "Rain fell on the city.", narratorVoice: { provider: "elevenlabs", voiceId: "voice_narrator" },
      characters: [akira], dialogue: [{ character: "Akira", line: "Tch." }] });
    expect(segments[0]!.characterId).toBe("narrator");
    expect(segments[0]!.voice!.voiceId).toBe("voice_narrator");
    expect(segments[1]!.voice!.voiceId).toBe("voice_akira_001");
  });
  it("resolves honorifics / surname forms but never guesses on ambiguity", () => {
    expect(resolveSpeaker("Akira-kun", [akira, mika])?.id).toBe("c_akira");
    expect(resolveSpeaker("Mika", [akira, mika])?.id).toBe("c_mika");
    expect(resolveSpeaker("Sato", [akira, mika])?.id).toBe("c_mika");
    const a1: CharacterInfo = { id: "1", name: "Ken Ito" }, a2: CharacterInfo = { id: "2", name: "Ken Mori" };
    expect(resolveSpeaker("Ken", [a1, a2])).toBeNull();
  });
  it("UNKNOWN speaker gets NO borrowed voice and is reported", () => {
    const { segments, issues } = planDialogueSegments({ sceneNumber: 1, characters: [akira], dialogue: [{ character: "Stranger", line: "Hello." }] });
    expect(segments[0]!.voice).toBeNull();
    expect(segments[0]!.voiceFallback).toBe(true);
    expect(segments[0]!.characterId).toBe("unknown:stranger");
    expect(issues.map((i) => i.code)).toContain("UNKNOWN_SPEAKER");
    expect(issues.map((i) => i.code)).toContain("NO_VOICE_ASSIGNED");
  });
  it("flags characters that share one voice", () => {
    const same = { provider: "elevenlabs", voiceId: "v" };
    const { issues } = planDialogueSegments({ sceneNumber: 1, characters: [{ ...akira, voice: same }, { ...mika, voice: same }], dialogue: [{ character: "Akira", line: "a" }, { character: "Mika", line: "b" }] });
    expect(issues.map((i) => i.code)).toContain("SHARED_VOICE");
  });
  it("skips empty lines, tolerates malformed entries, splits very long lines", () => {
    const long = "This is a sentence. ".repeat(80);
    const { segments, issues } = planDialogueSegments({ sceneNumber: 1, characters: [akira], maxCharsPerSegment: 400,
      dialogue: [{ character: "Akira", line: "   " }, null as never, { character: "Akira", line: long }] });
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.every((s) => s.text.length <= 400)).toBe(true);
    expect(issues.map((i) => i.code)).toContain("EMPTY_LINE");
    expect(new Set(segments.map((s) => s.segmentId)).size).toBe(segments.length);
    expect(splitLongText("short", 100)).toEqual(["short"]);
  });
  it("emotion per line: explicit > text cue > character default > scene mood", () => {
    const { segments } = planDialogueSegments({ sceneNumber: 1, characters: [akira, mika], sceneMood: "sad and somber", dialogue: [
      { character: "Akira", line: "Get out.", emotion: "angrily" }, { character: "Akira", line: "STOP RIGHT NOW" }, { character: "Akira", line: "Fine." }, { character: "Mika", line: "I see." } ] });
    expect(segments.map((s) => s.emotion)).toEqual(["angry", "shouting", "serious", "sad"]);
  });
});

describe("castVoices - persistent, distinct identities", () => {
  const pool = [{ voiceId: "p1", gender: "female" as const }, { voiceId: "p2", gender: "male" as const }, { voiceId: "p3", gender: "male" as const }];
  it("keeps existing assignments and gives new characters distinct, gender-matched voices", () => {
    const r = castVoices([{ id: "a", name: "A", gender: "male", voice: { provider: "elevenlabs", voiceId: "p2" } }, { id: "b", name: "B", gender: "male" }, { id: "c", name: "C", gender: "female" }], "elevenlabs", pool);
    expect(r.voices.get("a")!.voiceId).toBe("p2");
    expect(r.voices.get("b")!.voiceId).toBe("p3");
    expect(r.voices.get("c")!.voiceId).toBe("p1");
    expect(r.newlyAssigned.sort()).toEqual(["b", "c"]);
  });
  it("is deterministic and stable when re-run with the persisted result", () => {
    const chars: CharacterInfo[] = [{ id: "z", name: "Z", gender: "male" }, { id: "y", name: "Y", gender: "female" }];
    const r1 = castVoices(chars, "elevenlabs", pool);
    const persisted = chars.map((c) => ({ ...c, voice: r1.voices.get(c.id)! }));
    const r2 = castVoices(persisted, "elevenlabs", pool);
    expect(Object.fromEntries(r2.voices)).toEqual(Object.fromEntries(r1.voices));
    expect(r2.newlyAssigned).toEqual([]);
  });
  it("warns (does not pretend) when the pool is exhausted", () => {
    const r = castVoices([{ id: "a", name: "A" }, { id: "b", name: "B" }], "elevenlabs", [{ voiceId: "only" }], { provider: "elevenlabs", voiceId: "default" });
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toMatch(/default voice/);
  });
});

describe("emotion profiles and provider mapping", () => {
  it("covers all 16 required emotions with sane profiles", () => {
    expect(EMOTIONS).toHaveLength(16);
    for (const e of EMOTIONS) {
      const p = buildEmotionProfile(e);
      expect(p.speechRate).toBeGreaterThan(0.7); expect(p.speechRate).toBeLessThan(1.3);
      expect(p.intensity).toBeGreaterThan(0); expect(p.intensity).toBeLessThanOrEqual(1);
    }
  });
  it("angry@0.85 matches the spec example (rate ~1.08, angry face, aggressive gestures)", () => {
    const p = buildEmotionProfile("angry", 0.85);
    expect(p.speechRate).toBeCloseTo(1.08, 1);
    expect(p.facialExpression).toBe("angry"); expect(p.gestureStyle).toBe("aggressive");
  });
  it("intensity scales the deviation from neutral", () => {
    expect(buildEmotionProfile("excited", 0.2).speechRate).toBeLessThan(buildEmotionProfile("excited", 1).speechRate);
    expect(buildEmotionProfile("sad", 0).speechRate).toBe(1);
  });
  it("ElevenLabs-style caps: emits speed/stability/style, REPORTS pitch as ignored (no invented params)", () => {
    const m = mapEmotionToVoiceParams(buildEmotionProfile("excited", 0.9), { provider: "elevenlabs", speed: { min: 0.7, max: 1.2 }, stability: true, similarityBoost: true, style: true }, { stability: 0.5, similarityBoost: 0.8, style: 0.3 });
    expect(m.settings.speed).toBeGreaterThan(1); expect(m.settings.speed).toBeLessThanOrEqual(1.2);
    expect(m.settings.stability).toBeLessThan(0.5);
    expect(m.settings.style).toBeGreaterThan(0.3);
    expect(m.settings.pitchSemitones).toBeUndefined();
    expect(m.ignored).toContain("pitch");
    expect(m.settings.instructions).toBeUndefined();
  });
  it("OpenAI-style caps: emits speed + instructions only", () => {
    const m = mapEmotionToVoiceParams(buildEmotionProfile("sad", 0.8), { provider: "openai", speed: { min: 0.25, max: 4 }, instructions: true });
    expect(m.settings.speed).toBeLessThan(1);
    expect(m.settings.instructions).toMatch(/sad/);
    expect(m.settings.stability).toBeUndefined();
  });
  it("clamps speed to the provider range", () => {
    const m = mapEmotionToVoiceParams(buildEmotionProfile("excited", 1), { provider: "x", speed: { min: 0.95, max: 1.05 } });
    expect(m.settings.speed).toBe(1.05);
  });
  it("normalizes aliases; unknown values return null", () => {
    expect(normalizeEmotion("Terrified")).toBe("fear");
    for (const [adv, e] of [["angrily", "angry"], ["sadly", "sad"], ["happily", "happy"], ["nervously", "nervous"], ["excitedly", "excited"], ["calmly", "calm"], ["seriously", "serious"], ["fearfully", "fear"]] as const) expect(normalizeEmotion(adv)).toBe(e); expect(normalizeEmotion("yelling")).toBe("shouting"); expect(normalizeEmotion("zzz")).toBeNull();
    expect(resolveEmotion({ text: "hi" })).toBe("calm");
  });
  it("pronunciation lexicon replaces whole words only", () => {
    expect(applyPronunciation("Akira and Akiranda", { Akira: "Ah-kee-rah" })).toBe("Ah-kee-rah and Akiranda");
  });
});
