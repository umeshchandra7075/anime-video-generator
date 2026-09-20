export interface TTSRequest {
  text: string;
  language: string;
  voiceGender: "male" | "female" | "neutral";
  voiceStyle: string;
  voiceId?: string; // overrides the provider's default voice mapping
  // Optional per-request voice tuning, normally supplied by resolving a
  // character's voice config (see src/lib/domain/characterVoice.ts).
  // Any field left undefined falls back to the provider's own defaults, so
  // existing callers that only pass voiceId/voiceStyle keep working exactly
  // as before.
  modelId?: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  speed?: number;
  /** Free-text delivery direction, only honoured by providers that declare
   * `capabilities.instructions` (e.g. OpenAI gpt-4o-mini-tts). */
  instructions?: string;
  /** Ask the provider for per-character timing when it supports it. */
  withTimestamps?: boolean;
  /** Abort the call after this long (ms). */
  timeoutMs?: number;
}

export interface GeneratedAudio {
  audioBase64: string;
  mimeType: string; // e.g. "audio/mpeg"
  providerName: string;
  providerMetadata?: Record<string, unknown>;
  /** Provider-reported character timing (seconds, relative to the audio start).
   * Present ONLY when the provider really returned it. */
  alignment?: { characters: string[]; startTimes: number[]; endTimes: number[] };
}

/** What a provider can actually control. Emotion mapping emits ONLY these. */
export interface VoiceCapabilities {
  provider: string;
  speed?: { min: number; max: number };
  pitch?: boolean;
  stability?: boolean;
  similarityBoost?: boolean;
  style?: boolean;
  instructions?: boolean;
  timestamps?: boolean;
}

/**
 * Abstraction over any text-to-speech backend (the "VoiceProvider" of the spec):
 * ElevenLabs and OpenAI are implemented; Google/Azure are declared in the factory
 * as not implemented rather than faked.
 */
export interface TTSProvider {
  readonly name: string;
  /** Declared controls; used to map emotion -> parameters without inventing any. */
  readonly capabilities?: VoiceCapabilities;
  synthesize(request: TTSRequest): Promise<GeneratedAudio>;
}
