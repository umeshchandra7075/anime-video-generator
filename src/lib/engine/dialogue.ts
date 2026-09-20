import type { Emotion, PlannedSegment, VoiceRef } from "./types";
import { NARRATOR_ID } from "./types";
import { buildEmotionProfile, normalizeEmotion, resolveEmotion } from "./emotion";

export interface CharacterInfo {
  id: string;
  name: string;
  aliases?: string[];
  gender?: string | null;
  voice?: VoiceRef | null;
  defaultEmotion?: Emotion | null;
}

export interface RawDialogueLine { character: string; line: string; emotion?: string; intensity?: number }

export type SegmentIssueCode = "UNKNOWN_SPEAKER" | "NO_VOICE_ASSIGNED" | "SHARED_VOICE" | "EMPTY_LINE" | "LINE_SPLIT";
export interface SegmentIssue { code: SegmentIssueCode; segmentId?: string; message: string }

export interface PlanInput {
  sceneNumber: number;
  narration?: string | null;
  dialogue: RawDialogueLine[];
  characters: CharacterInfo[];
  sceneMood?: string | null;
  narratorVoice?: VoiceRef | null;
  maxCharsPerSegment?: number;
}

const HONORIFICS = /\b(san|kun|chan|sama|sensei|senpai|dono|mr|mrs|ms|miss|dr|prof)\b\.?/gi;

export function normalizeName(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(HONORIFICS, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Resolve a speaker label from LLM output to a known character.
 * Exact normalized name / alias first; then a UNIQUE first-token match
 * ("Akira Tanaka" <-> "Akira"). Ambiguity resolves to null - we never guess. */
export function resolveSpeaker(label: string, characters: CharacterInfo[]): CharacterInfo | null {
  const n = normalizeName(label);
  if (!n) return null;
  const exact = characters.filter((c) => normalizeName(c.name) === n || (c.aliases ?? []).some((a) => normalizeName(a) === n));
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return null;
  const nt = n.split(" ");
  const loose = characters.filter((c) => {
    const ct = normalizeName(c.name).split(" ");
    return ct[0] === nt[0] || (nt.length === 1 && ct.includes(nt[0]!));
  });
  return loose.length === 1 ? loose[0]! : null;
}

export function splitLongText(text: string, maxChars: number): string[] {
  const t = text.trim();
  if (t.length <= maxChars) return [t];
  const sentences = t.match(/[^.!?。！？]+[.!?。！？]*\s*/gu) ?? [t];
  const parts: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + s).length > maxChars && cur) { parts.push(cur.trim()); cur = ""; }
    cur += s;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.flatMap((p) => (p.length > maxChars ? p.match(new RegExp(`.{1,${maxChars}}`, "gu")) ?? [p] : [p]));
}

const pad = (n: number, w = 3) => String(n).padStart(w, "0");
const slug = (s: string) => normalizeName(s).replace(/\s+/g, "_").slice(0, 32) || "unknown";

/**
 * One PlannedSegment per spoken line. Narration (if any) comes first, then
 * dialogue in script order. Each segment is bound to ITS speaker's voice - a
 * segment for a speaker with no resolvable voice is flagged, never silently
 * given another character's voice.
 */
export function planDialogueSegments(input: PlanInput): { segments: PlannedSegment[]; issues: SegmentIssue[] } {
  const { sceneNumber, characters } = input;
  const maxChars = input.maxCharsPerSegment ?? 900;
  const segments: PlannedSegment[] = [];
  const issues: SegmentIssue[] = [];
  let index = 0;

  const push = (base: { characterId: string; speakerName: string; text: string; voice: VoiceRef | null; explicitEmotion?: unknown; intensity?: number; defaultEmotion?: Emotion | null }) => {
    const pieces = splitLongText(base.text, maxChars);
    if (pieces.length > 1) issues.push({ code: "LINE_SPLIT", message: `Scene ${sceneNumber}: a ${base.text.length}-char line by ${base.speakerName} was split into ${pieces.length} segments.` });
    for (const text of pieces) {
      index += 1;
      const segmentId = `dlg_${pad(sceneNumber)}_${pad(index)}`;
      const emotion = resolveEmotion({ explicit: base.explicitEmotion, text, characterDefault: base.defaultEmotion, sceneMood: input.sceneMood });
      const profile = buildEmotionProfile(emotion, base.intensity);
      const voiceFallback = base.voice === null;
      if (voiceFallback) issues.push({ code: "NO_VOICE_ASSIGNED", segmentId, message: `${base.speakerName} has no assigned voice; the provider default voice will be used.` });
      segments.push({ segmentId, characterId: base.characterId, speakerName: base.speakerName, text, emotion, intensity: profile.intensity, voice: base.voice, voiceFallback, profile });
    }
  };

  if (input.narration && input.narration.trim()) {
    push({ characterId: NARRATOR_ID, speakerName: "Narrator", text: input.narration, voice: input.narratorVoice ?? null, explicitEmotion: "calm" });
  }

  for (const line of input.dialogue) {
    if (!line || typeof line.line !== "string" || !line.line.trim()) {
      issues.push({ code: "EMPTY_LINE", message: `Scene ${sceneNumber}: skipped an empty dialogue line.` });
      continue;
    }
    const who = typeof line.character === "string" ? resolveSpeaker(line.character, characters) : null;
    if (who) {
      push({ characterId: who.id, speakerName: who.name, text: line.line, voice: who.voice ?? null, explicitEmotion: line.emotion, intensity: line.intensity, defaultEmotion: who.defaultEmotion });
    } else {
      const label = String(line.character ?? "Unknown");
      issues.push({ code: "UNKNOWN_SPEAKER", message: `Scene ${sceneNumber}: speaker "${label}" matches no known character; NOT borrowing another character's voice.` });
      push({ characterId: `unknown:${slug(label)}`, speakerName: label, text: line.line, voice: null, explicitEmotion: line.emotion, intensity: line.intensity });
    }
  }

  // Distinct characters on the same voice is a casting problem worth surfacing.
  const byVoice = new Map<string, Set<string>>();
  for (const s of segments) if (s.voice) {
    const k = `${s.voice.provider}:${s.voice.voiceId}`;
    (byVoice.get(k) ?? byVoice.set(k, new Set()).get(k)!).add(s.speakerName);
  }
  for (const [, names] of byVoice) if (names.size > 1) issues.push({ code: "SHARED_VOICE", message: `Characters ${[...names].join(", ")} share one voice.` });

  return { segments, issues };
}

// ---------------------------------------------------------------------------
// Persistent voice casting
// ---------------------------------------------------------------------------
export interface VoicePoolEntry { voiceId: string; gender?: "male" | "female" | "neutral"; label?: string }

export interface CastingResult {
  voices: Map<string, VoiceRef>; // characterId -> voice
  newlyAssigned: string[]; // characterIds whose assignment must be persisted
  warnings: string[];
}

/**
 * Keeps every existing assignment untouched (persistence), and gives each
 * un-cast character a DISTINCT unused voice from the pool (gender match
 * preferred). Deterministic: candidates are processed in id order. When the
 * pool is exhausted the default voice is used and a warning says who shares it.
 */
export function castVoices(characters: CharacterInfo[], provider: string, pool: VoicePoolEntry[], defaultVoice?: VoiceRef | null): CastingResult {
  const voices = new Map<string, VoiceRef>();
  const used = new Set<string>();
  const newlyAssigned: string[] = [];
  const warnings: string[] = [];

  for (const c of characters) if (c.voice) { voices.set(c.id, c.voice); used.add(c.voice.voiceId); }

  const todo = characters.filter((c) => !c.voice).sort((a, b) => a.id.localeCompare(b.id));
  for (const c of todo) {
    const g = (c.gender ?? "").toLowerCase();
    const want = g.startsWith("m") ? "male" : g.startsWith("f") ? "female" : null;
    const free = pool.filter((p) => !used.has(p.voiceId));
    const pick = (want ? free.find((p) => p.gender === want) : undefined) ?? free.find((p) => !p.gender || p.gender === "neutral") ?? free[0];
    if (pick) {
      const v: VoiceRef = { provider, voiceId: pick.voiceId };
      voices.set(c.id, v); used.add(pick.voiceId); newlyAssigned.push(c.id);
    } else if (defaultVoice) {
      voices.set(c.id, defaultVoice);
      const sharers = characters.filter((o) => voices.get(o.id)?.voiceId === defaultVoice.voiceId).map((o) => o.name);
      warnings.push(`No unused voice left in the pool for ${c.name}; using the default voice (shared with: ${sharers.join(", ")}). Add voices to the pool or assign one manually.`);
    } else {
      warnings.push(`No voice available for ${c.name}: pool is empty and no default voice is configured.`);
    }
  }
  return { voices, newlyAssigned, warnings };
}
