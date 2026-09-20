import { TTSProvider, TTSRequest, GeneratedAudio, VoiceCapabilities } from "@/lib/ai/interfaces/tts-provider";
import {
  ProviderAuthError,
  ProviderNotConfiguredError,
  ProviderRequestError,
  ProviderTimeoutError,
} from "@/lib/ai/errors/provider-errors";
import { logger } from "@/lib/logger";

const PROVIDER_NAME = "elevenlabs";

export class ElevenLabsTtsProvider implements TTSProvider {
  readonly name = PROVIDER_NAME;
  // Only what the ElevenLabs API really exposes: speed 0.7-1.2, stability, similarity_boost, style.
  // No pitch and no free-text emotion control - the emotion mapper reports those as ignored.
  readonly capabilities: VoiceCapabilities = {
    provider: PROVIDER_NAME,
    speed: { min: 0.7, max: 1.2 },
    stability: true,
    similarityBoost: true,
    style: true,
    timestamps: true,
  };

  async synthesize(request: TTSRequest): Promise<GeneratedAudio> {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) throw new ProviderNotConfiguredError(PROVIDER_NAME);

    const baseUrl = process.env.ELEVENLABS_BASE_URL ?? "https://api.elevenlabs.io/v1";
    // Rule (per spec): a character-specific voiceId always wins; otherwise
    // fall back to the project-wide ELEVENLABS_DEFAULT_VOICE_ID. Never a
    // hardcoded literal voice ID.
    const voiceId = request.voiceId ?? process.env.ELEVENLABS_DEFAULT_VOICE_ID;
    if (!voiceId) {
      throw new ProviderRequestError(
        PROVIDER_NAME,
        "No ElevenLabs voice configured (set ELEVENLABS_DEFAULT_VOICE_ID or pass voiceId).",
      );
    }
    const modelId = request.modelId ?? process.env.ELEVENLABS_MODEL_ID ?? "eleven_multilingual_v2";
    const voiceSettings = buildVoiceSettings(request);

    // Opt-in: character-level timing lets the lip-sync use real word/character positions.
    // Off by default because it changes the response format (JSON with base64 audio) and has
    // not been exercised against the live API in this repository's tests.
    const wantTimestamps = !!request.withTimestamps && process.env.ELEVENLABS_USE_TIMESTAMPS === "true";
    const endpoint = wantTimestamps ? `${baseUrl}/text-to-speech/${voiceId}/with-timestamps` : `${baseUrl}/text-to-speech/${voiceId}`;
    const timeoutMs = request.timeoutMs ?? Number(process.env.ELEVENLABS_TIMEOUT_MS || 60_000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": apiKey,
          Accept: wantTimestamps ? "application/json" : "audio/mpeg",
        },
        body: JSON.stringify({
          text: request.text,
          model_id: modelId,
          voice_settings: voiceSettings,
        }),
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      if (controller.signal.aborted) throw new ProviderTimeoutError(PROVIDER_NAME);
      throw new ProviderRequestError(PROVIDER_NAME, "Network error contacting ElevenLabs.");
    }

    if (res.status === 401 || res.status === 403) { clearTimeout(timer); throw new ProviderAuthError(PROVIDER_NAME); }

    if (!res.ok) {
      clearTimeout(timer);
      const bodyText = await res.text().catch(() => "");
      logger.warn({ status: res.status, provider: PROVIDER_NAME, bodyText }, "provider_request_failed");
      throw new ProviderRequestError(
        PROVIDER_NAME,
        `ElevenLabs request failed with status ${res.status}.`,
        res.status,
      );
    }

    try {
      if (wantTimestamps) {
        const json = (await res.json()) as {
          audio_base64?: string;
          alignment?: { characters?: string[]; character_start_times_seconds?: number[]; character_end_times_seconds?: number[] };
        };
        if (!json.audio_base64) throw new ProviderRequestError(PROVIDER_NAME, "ElevenLabs timestamps response contained no audio.");
        const a = json.alignment;
        const alignment = a?.characters && a.character_start_times_seconds && a.character_end_times_seconds
          ? { characters: a.characters, startTimes: a.character_start_times_seconds, endTimes: a.character_end_times_seconds }
          : undefined;
        return { audioBase64: json.audio_base64, mimeType: "audio/mpeg", providerName: PROVIDER_NAME, providerMetadata: { voiceId, modelId, voiceSettings, alignmentReturned: !!alignment }, alignment };
      }
      const arrayBuffer = await res.arrayBuffer();
      const audioBase64 = Buffer.from(arrayBuffer).toString("base64");
      return { audioBase64, mimeType: "audio/mpeg", providerName: PROVIDER_NAME, providerMetadata: { voiceId, modelId, voiceSettings } };
    } catch (err) {
      if (controller.signal.aborted) throw new ProviderTimeoutError(PROVIDER_NAME);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Base stability/similarity by narrative voiceStyle (unchanged from before -
 * kept as the fallback so callers that don't resolve a character voice
 * config still get sensible, style-appropriate settings), layered with any
 * explicit per-character overrides (stability/similarityBoost/style/speed)
 * resolved by src/lib/domain/characterVoice.ts.
 */
function buildVoiceSettings(request: TTSRequest): {
  stability: number;
  similarity_boost: number;
  use_speaker_boost: boolean;
  style?: number;
  speed?: number;
} {
  const base = mapVoiceStyleToSettings(request.voiceStyle);
  const settings: {
    stability: number;
    similarity_boost: number;
    use_speaker_boost: boolean;
    style?: number;
    speed?: number;
  } = {
    stability: request.stability ?? base.stability,
    similarity_boost: request.similarityBoost ?? base.similarity_boost,
    use_speaker_boost: true,
  };
  if (request.style !== undefined) settings.style = request.style;
  if (request.speed !== undefined) settings.speed = request.speed;
  return settings;
}

function mapVoiceStyleToSettings(style: string): { stability: number; similarity_boost: number } {
  switch (style) {
    case "dramatic":
      return { stability: 0.3, similarity_boost: 0.8 };
    case "energetic":
      return { stability: 0.35, similarity_boost: 0.7 };
    case "calm":
      return { stability: 0.7, similarity_boost: 0.6 };
    case "narrator":
      return { stability: 0.6, similarity_boost: 0.75 };
    default:
      return { stability: 0.5, similarity_boost: 0.7 };
  }
}
