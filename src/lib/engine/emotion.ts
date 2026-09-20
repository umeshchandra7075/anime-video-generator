import type { Emotion, EmotionProfile, FacialExpression, GestureStyle, PauseProfile } from "./types";
import { EMOTIONS } from "./types";

interface EmotionBase {
  speechRate: number; // at intensity 1
  pitch: number; // semitones at intensity 1
  pause: PauseProfile; // seconds at intensity 1
  face: FacialExpression;
  gesture: GestureStyle;
  defaultIntensity: number;
  arousal: "high" | "low" | "neutral"; // drives expressiveness (stability/style) mapping
}

const BASE: Record<Emotion, EmotionBase> = {
  happy:      { speechRate: 1.05, pitch: 1.0,  pause: { beforeSec: 0.05, afterSec: 0.12 }, face: "happy",      gesture: "expressive", defaultIntensity: 0.6, arousal: "high" },
  sad:        { speechRate: 0.88, pitch: -1.5, pause: { beforeSec: 0.15, afterSec: 0.35 }, face: "sad",        gesture: "subtle",     defaultIntensity: 0.6, arousal: "low" },
  angry:      { speechRate: 1.09, pitch: -0.5, pause: { beforeSec: 0.05, afterSec: 0.10 }, face: "angry",      gesture: "aggressive", defaultIntensity: 0.7, arousal: "high" },
  excited:    { speechRate: 1.15, pitch: 2.0,  pause: { beforeSec: 0.03, afterSec: 0.08 }, face: "happy",      gesture: "expressive", defaultIntensity: 0.7, arousal: "high" },
  fear:       { speechRate: 1.10, pitch: 1.5,  pause: { beforeSec: 0.10, afterSec: 0.20 }, face: "afraid",     gesture: "trembling",  defaultIntensity: 0.7, arousal: "high" },
  surprised:  { speechRate: 1.05, pitch: 2.5,  pause: { beforeSec: 0.00, afterSec: 0.25 }, face: "surprised",  gesture: "expressive", defaultIntensity: 0.7, arousal: "high" },
  calm:       { speechRate: 0.95, pitch: 0.0,  pause: { beforeSec: 0.10, afterSec: 0.20 }, face: "neutral",    gesture: "calm",       defaultIntensity: 0.4, arousal: "low" },
  serious:    { speechRate: 0.96, pitch: -1.0, pause: { beforeSec: 0.10, afterSec: 0.22 }, face: "neutral",    gesture: "subtle",     defaultIntensity: 0.6, arousal: "low" },
  romantic:   { speechRate: 0.90, pitch: -0.5, pause: { beforeSec: 0.15, afterSec: 0.30 }, face: "romantic",   gesture: "subtle",     defaultIntensity: 0.6, arousal: "low" },
  confused:   { speechRate: 0.95, pitch: 0.5,  pause: { beforeSec: 0.20, afterSec: 0.30 }, face: "confused",   gesture: "subtle",     defaultIntensity: 0.6, arousal: "neutral" },
  whispering: { speechRate: 0.90, pitch: -1.0, pause: { beforeSec: 0.10, afterSec: 0.25 }, face: "neutral",    gesture: "none",       defaultIntensity: 0.7, arousal: "low" },
  shouting:   { speechRate: 1.10, pitch: 1.5,  pause: { beforeSec: 0.03, afterSec: 0.10 }, face: "angry",      gesture: "aggressive", defaultIntensity: 0.85, arousal: "high" },
  crying:     { speechRate: 0.85, pitch: 0.5,  pause: { beforeSec: 0.20, afterSec: 0.40 }, face: "sad",        gesture: "trembling",  defaultIntensity: 0.8, arousal: "high" },
  laughing:   { speechRate: 1.12, pitch: 1.5,  pause: { beforeSec: 0.05, afterSec: 0.15 }, face: "happy",      gesture: "expressive", defaultIntensity: 0.7, arousal: "high" },
  determined: { speechRate: 1.00, pitch: -0.5, pause: { beforeSec: 0.10, afterSec: 0.18 }, face: "determined", gesture: "expressive", defaultIntensity: 0.7, arousal: "neutral" },
  nervous:    { speechRate: 1.08, pitch: 0.8,  pause: { beforeSec: 0.15, afterSec: 0.25 }, face: "nervous",    gesture: "trembling",  defaultIntensity: 0.6, arousal: "neutral" },
};

const ALIASES: Record<string, Emotion> = {
  joyful: "happy", cheerful: "happy", glad: "happy", pleased: "happy", smiling: "happy",
  upset: "sad", sorrowful: "sad", melancholy: "sad", depressed: "sad", grieving: "sad",
  furious: "angry", irritated: "angry", annoyed: "angry", mad: "angry", rage: "angry",
  thrilled: "excited", enthusiastic: "excited", eager: "excited",
  scared: "fear", fearful: "fear", afraid: "fear", terrified: "fear", frightened: "fear", worried: "nervous", anxious: "nervous",
  shocked: "surprised", astonished: "surprised", amazed: "surprised", startled: "surprised",
  neutral: "calm", relaxed: "calm", peaceful: "calm", gentle: "calm",
  stern: "serious", grave: "serious", cold: "serious", firm: "serious",
  loving: "romantic", tender: "romantic", affectionate: "romantic",
  puzzled: "confused", uncertain: "confused", hesitant: "nervous",
  whisper: "whispering", murmuring: "whispering", hushed: "whispering",
  shout: "shouting", yelling: "shouting", screaming: "shouting", yell: "shouting",
  sobbing: "crying", weeping: "crying", tearful: "crying",
  laugh: "laughing", giggling: "laughing", amused: "laughing",
  resolute: "determined", brave: "determined", confident: "determined",
};

const SCENE_MOOD_TO_EMOTION: Array<[RegExp, Emotion]> = [
  [/tense|ominous|dark|dramatic|foreboding/i, "serious"],
  [/sad|melanchol|somber|tragic/i, "sad"],
  [/happy|joy|cheer|lighthearted|festive/i, "happy"],
  [/romantic|tender|intimate/i, "romantic"],
  [/action|battle|fight|intense/i, "determined"],
  [/calm|peaceful|serene|quiet/i, "calm"],
  [/mysterious|eerie|scary|horror/i, "nervous"],
];

export function isEmotion(v: unknown): v is Emotion {
  return typeof v === "string" && (EMOTIONS as readonly string[]).includes(v);
}

export function normalizeEmotion(raw: unknown): Emotion | null {
  if (typeof raw !== "string") return null;
  const k = raw.trim().toLowerCase();
  if (isEmotion(k)) return k;
  if (ALIASES[k]) return ALIASES[k]!;
  // LLMs often emit adverbs ("angrily", "nervously", "sadly", "happily"): try the adjective stem.
  const stems = [k.replace(/ily$/, "y"), k.replace(/ly$/, ""), k.replace(/fully$/, "ful")];
  for (const stem of stems) {
    if (stem === k) continue;
    if (isEmotion(stem)) return stem;
    if (ALIASES[stem]) return ALIASES[stem]!;
  }
  return null;
}

/** Resolve a segment's emotion: explicit (normalized) > strong text cue >
 * character default > scene mood > calm. Text cues are deliberately
 * conservative (only ALL-CAPS shouting and "?!" surprise). */
export function resolveEmotion(opts: { explicit?: unknown; text: string; characterDefault?: Emotion | null; sceneMood?: string | null }): Emotion {
  const explicit = normalizeEmotion(opts.explicit);
  if (explicit) return explicit;
  const words = opts.text.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
  const caps = words.filter((w) => w.replace(/[^A-Za-z]/g, "").length >= 3 && w === w.toUpperCase());
  if (caps.length >= 2 || /!{2,}/.test(opts.text)) return "shouting";
  if (/\?!|!\?/.test(opts.text)) return "surprised";
  if (opts.characterDefault) return opts.characterDefault;
  if (opts.sceneMood) for (const [re, e] of SCENE_MOOD_TO_EMOTION) if (re.test(opts.sceneMood)) return e;
  return "calm";
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

/** Deviation from neutral scales linearly with intensity. */
export function buildEmotionProfile(emotion: Emotion, intensity?: number): EmotionProfile {
  const b = BASE[emotion];
  const i = clamp(intensity ?? b.defaultIntensity, 0, 1);
  return {
    emotion,
    intensity: round(i, 2),
    speechRate: round(1 + (b.speechRate - 1) * i),
    pitchModifier: round(b.pitch * i, 2),
    pauseProfile: { beforeSec: round(b.pause.beforeSec * (0.5 + i * 0.5)), afterSec: round(b.pause.afterSec * (0.5 + i * 0.5)) },
    facialExpression: b.face,
    gestureStyle: i < 0.25 && b.gesture !== "none" ? "subtle" : b.gesture,
  };
}

export function emotionArousal(emotion: Emotion): "high" | "low" | "neutral" {
  return BASE[emotion].arousal;
}

// ---------------------------------------------------------------------------
// Provider parameter mapping: ONLY parameters a provider declares are emitted;
// everything else is reported in `ignored` so the UI/logs can say so honestly.
// ---------------------------------------------------------------------------
export interface VoiceCapabilities {
  provider: string;
  speed?: { min: number; max: number };
  pitch?: boolean;
  stability?: boolean;
  similarityBoost?: boolean;
  style?: boolean;
  /** Free-text delivery instructions (e.g. OpenAI gpt-4o-mini-tts). */
  instructions?: boolean;
}

export interface VoiceBaseSettings { speed?: number; stability?: number; similarityBoost?: number; style?: number }
export interface MappedVoiceParams {
  settings: { speed?: number; pitchSemitones?: number; stability?: number; similarityBoost?: number; style?: number; instructions?: string };
  ignored: string[]; // requested-by-profile but unsupported by this provider
}

export function mapEmotionToVoiceParams(profile: EmotionProfile, caps: VoiceCapabilities, base: VoiceBaseSettings = {}): MappedVoiceParams {
  const settings: MappedVoiceParams["settings"] = {};
  const ignored: string[] = [];
  const arousal = emotionArousal(profile.emotion);
  const i = profile.intensity;

  if (caps.speed) settings.speed = round(clamp((base.speed ?? 1) * profile.speechRate, caps.speed.min, caps.speed.max));
  else if (Math.abs(profile.speechRate - 1) > 0.005) ignored.push("speed");

  if (caps.pitch) settings.pitchSemitones = profile.pitchModifier;
  else if (Math.abs(profile.pitchModifier) > 0.05) ignored.push("pitch");

  if (caps.stability) {
    const b = base.stability ?? 0.5;
    const delta = arousal === "high" ? -0.25 * i : arousal === "low" ? 0.1 * i : 0;
    settings.stability = round(clamp(b + delta, 0, 1));
  }
  if (caps.similarityBoost && base.similarityBoost !== undefined) settings.similarityBoost = round(clamp(base.similarityBoost, 0, 1));
  if (caps.style) {
    const b = base.style ?? 0.3;
    settings.style = round(clamp(b + (arousal === "high" ? 0.3 * i : 0), 0, 1));
  }
  if (caps.instructions) {
    const pace = profile.speechRate > 1.03 ? "a slightly fast pace" : profile.speechRate < 0.97 ? "a slower pace" : "a natural pace";
    settings.instructions = `Speak in a ${profile.emotion} tone (intensity ${Math.round(i * 100)}%), with ${pace}. Sound like an anime character performing dialogue, not a narrator.`;
  } else if (profile.emotion === "whispering" || profile.emotion === "shouting") {
    ignored.push("delivery-style"); // no provider-native whisper/shout control is claimed
  }
  return { settings, ignored };
}

/** Apply a pronunciation lexicon (whole-word, case-insensitive) before TTS. */
export function applyPronunciation(text: string, lexicon?: Record<string, string> | null): string {
  if (!lexicon) return text;
  let out = text;
  for (const [word, spoken] of Object.entries(lexicon)) {
    if (!word) continue;
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "giu"), spoken);
  }
  return out;
}
