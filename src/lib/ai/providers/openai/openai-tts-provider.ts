import type { TTSProvider, TTSRequest, GeneratedAudio, VoiceCapabilities } from "@/lib/ai/interfaces/tts-provider";
import {
  ProviderAuthError,
  ProviderNotConfiguredError,
  ProviderRequestError,
  ProviderTimeoutError,
} from "@/lib/ai/errors/provider-errors";

const PROVIDER_NAME = "openai";

/**
 * OpenAI text-to-speech (POST /v1/audio/speech). Controls it really has:
 *  - `speed` (0.25-4.0)
 *  - `instructions` (free-text delivery direction) - gpt-4o-mini-tts ONLY
 * It has no pitch, stability or similarity controls, so the emotion mapper
 * reports those as ignored rather than pretending.
 * Voices are named ("alloy", "nova", ...); a character's voiceId is that name.
 * Single attempt with a timeout - retry/backoff is handled by the voice pipeline.
 */
export class OpenAITtsProvider implements TTSProvider {
  readonly name = PROVIDER_NAME;
  readonly capabilities: VoiceCapabilities;
  private readonly model: string;

  constructor() {
    this.model = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
    this.capabilities = {
      provider: PROVIDER_NAME,
      speed: { min: 0.25, max: 4.0 },
      instructions: this.model.startsWith("gpt-4o"),
    };
  }

  async synthesize(request: TTSRequest): Promise<GeneratedAudio> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new ProviderNotConfiguredError(PROVIDER_NAME);
    const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
    const voice = request.voiceId || process.env.OPENAI_TTS_VOICE || "alloy";
    const model = request.modelId || this.model;

    const body: Record<string, unknown> = { model, input: request.text, voice, response_format: "mp3" };
    if (request.speed !== undefined) body.speed = Math.min(4, Math.max(0.25, request.speed));
    if (request.instructions && model.startsWith("gpt-4o")) body.instructions = request.instructions;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? Number(process.env.OPENAI_TIMEOUT_MS || 60_000));
    try {
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/audio/speech`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) throw new ProviderTimeoutError(PROVIDER_NAME);
        throw new ProviderRequestError(PROVIDER_NAME, "Network error contacting OpenAI.");
      }
      if (res.status === 401 || res.status === 403) throw new ProviderAuthError(PROVIDER_NAME);
      if (!res.ok) throw new ProviderRequestError(PROVIDER_NAME, `OpenAI TTS request failed with status ${res.status}.`, res.status);
      const audioBase64 = Buffer.from(await res.arrayBuffer()).toString("base64");
      return { audioBase64, mimeType: "audio/mpeg", providerName: PROVIDER_NAME, providerMetadata: { voice, model, speed: body.speed ?? null, instructionsApplied: "instructions" in body } };
    } catch (err) {
      if (controller.signal.aborted && !(err instanceof ProviderTimeoutError)) throw new ProviderTimeoutError(PROVIDER_NAME);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
