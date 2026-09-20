// Per-character ElevenLabs voice configuration. This is intentionally a
// thin, provider-shaped record (not a full "casting" abstraction) so it
// maps directly onto ElevenLabs' text-to-speech request body. Everything
// here is optional: an absent field means "fall back to the project-wide
// ElevenLabs default", never a hardcoded voice.
//
// Stored server-side only (Character.voiceConfig, JSON-encoded - see
// prisma/schema.prisma) and resolved server-side in the voice pipeline
// stage (src/lib/pipeline/voiceStage.ts). The ELEVENLABS_API_KEY never
// leaves the server; this type never touches it.
import { fromJson } from "@/lib/domain/json";

export interface CharacterVoiceConfig {
  voiceId?: string;
  modelId?: string;
  /** 0-1: lower = more expressive/variable, higher = more monotone/stable. */
  stability?: number;
  /** 0-1: how closely output should match the reference voice. */
  similarityBoost?: number;
  /** 0-1: exaggeration of the voice's style. */
  style?: number;
  /** Playback speed multiplier (ElevenLabs accepts roughly 0.7-1.2). */
  speed?: number;
  /** Which TTS provider `voiceId` belongs to ("elevenlabs" | "openai"). Absent = the active provider. */
  provider?: string;
  /** Persistent default emotion for this character's lines when a line has no explicit one. */
  defaultEmotion?: string;
  /** Whole-word pronunciation overrides applied to the text BEFORE synthesis, e.g. {"Akira":"Ah-kee-rah"}. */
  pronunciation?: Record<string, string>;
}

export interface ResolvedVoiceSettings {
  voiceId?: string;
  modelId: string;
  stability: number;
  similarityBoost: number;
  style: number;
  speed: number;
}

export interface CharacterVoiceEnvDefaults {
  defaultVoiceId?: string | null;
  defaultModelId?: string | null;
}

// Natural, expressive-but-stable defaults tuned for anime dialogue rather
// than flat narration - not silence-tolerant/monotone like the ElevenLabs
// SDK's own defaults.
export const NATURAL_ANIME_DIALOGUE_DEFAULTS = {
  stability: 0.45,
  similarityBoost: 0.8,
  style: 0.35,
  speed: 1.0,
} as const;

/** Parses the JSON-encoded value stored on Character.voiceConfig. */
export function parseCharacterVoiceConfig(
  raw: string | null | undefined,
): CharacterVoiceConfig {
  return fromJson<CharacterVoiceConfig>(raw, {});
}

/**
 * Resolves the final ElevenLabs request settings for a character.
 *
 * Rule (per spec): if the character has a voiceId, use it; otherwise fall
 * back to ELEVENLABS_DEFAULT_VOICE_ID. Every other field falls back
 * independently - a character can override just `style` and still inherit
 * the default voiceId/modelId, for example.
 */
export function resolveCharacterVoice(
  config: CharacterVoiceConfig | null | undefined,
  envDefaults: CharacterVoiceEnvDefaults = {},
): ResolvedVoiceSettings {
  const cfg = config ?? {};
  return {
    voiceId: cfg.voiceId || envDefaults.defaultVoiceId || undefined,
    modelId: cfg.modelId || envDefaults.defaultModelId || "eleven_multilingual_v2",
    stability: cfg.stability ?? NATURAL_ANIME_DIALOGUE_DEFAULTS.stability,
    similarityBoost: cfg.similarityBoost ?? NATURAL_ANIME_DIALOGUE_DEFAULTS.similarityBoost,
    style: cfg.style ?? NATURAL_ANIME_DIALOGUE_DEFAULTS.style,
    speed: cfg.speed ?? NATURAL_ANIME_DIALOGUE_DEFAULTS.speed,
  };
}
