import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ProviderAuthError,
  ProviderNotConfiguredError,
  ProviderRequestError,
} from "@/lib/ai/errors/provider-errors";
import { ElevenLabsTtsProvider } from "@/lib/ai/providers/elevenlabs/elevenlabs-tts-provider";
import type { TTSRequest } from "@/lib/ai/interfaces/tts-provider";

function baseRequest(overrides: Partial<TTSRequest> = {}): TTSRequest {
  return {
    text: "Hello there.",
    language: "en",
    voiceGender: "neutral",
    voiceStyle: "narrator",
    ...overrides,
  };
}

function mockFetchOnce(response: Partial<Response> & { ok: boolean; status: number }) {
  const fetchMock = vi.fn(async () => response as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function audioOkResponse() {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => new TextEncoder().encode("fake-mp3-bytes").buffer,
  };
}

describe("ElevenLabsTtsProvider", () => {
  beforeEach(() => {
    process.env.ELEVENLABS_API_KEY = "test-api-key";
    delete process.env.ELEVENLABS_DEFAULT_VOICE_ID;
    delete process.env.ELEVENLABS_MODEL_ID;
    delete process.env.ELEVENLABS_BASE_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("throws ProviderNotConfiguredError when ELEVENLABS_API_KEY is missing", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const provider = new ElevenLabsTtsProvider();
    await expect(provider.synthesize(baseRequest())).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });

  it("uses ELEVENLABS_DEFAULT_VOICE_ID when the request has no character-specific voiceId", async () => {
    process.env.ELEVENLABS_DEFAULT_VOICE_ID = "env-default-voice";
    process.env.ELEVENLABS_MODEL_ID = "eleven_multilingual_v2";
    const fetchMock = mockFetchOnce(audioOkResponse());

    const provider = new ElevenLabsTtsProvider();
    const result = await provider.synthesize(baseRequest());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/text-to-speech/env-default-voice");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model_id).toBe("eleven_multilingual_v2");
    expect(result.providerMetadata).toMatchObject({ voiceId: "env-default-voice" });
  });

  it("uses the character-specific voiceId/modelId/settings when provided, overriding the default", async () => {
    process.env.ELEVENLABS_DEFAULT_VOICE_ID = "env-default-voice";
    const fetchMock = mockFetchOnce(audioOkResponse());

    const provider = new ElevenLabsTtsProvider();
    await provider.synthesize(
      baseRequest({
        voiceId: "character-voice-abc",
        modelId: "eleven_turbo_v2",
        stability: 0.2,
        similarityBoost: 0.9,
        style: 0.4,
        speed: 1.05,
      }),
    );

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/text-to-speech/character-voice-abc");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model_id).toBe("eleven_turbo_v2");
    expect(body.voice_settings).toMatchObject({
      stability: 0.2,
      similarity_boost: 0.9,
      style: 0.4,
      speed: 1.05,
    });
  });

  it("falls back to ELEVENLABS_DEFAULT_VOICE_ID when a character has no voiceId of its own", async () => {
    process.env.ELEVENLABS_DEFAULT_VOICE_ID = "env-default-voice";
    const fetchMock = mockFetchOnce(audioOkResponse());

    const provider = new ElevenLabsTtsProvider();
    // Simulates voiceStage resolving a character with a config but no voiceId
    // (resolveCharacterVoice would already substitute the env default here,
    // but the provider itself must also do the right thing if voiceId is
    // simply absent from the request).
    await provider.synthesize(baseRequest({ voiceId: undefined }));

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/text-to-speech/env-default-voice");
  });

  it("throws ProviderRequestError when no voiceId is available anywhere", async () => {
    // No request.voiceId and no ELEVENLABS_DEFAULT_VOICE_ID configured.
    const provider = new ElevenLabsTtsProvider();
    await expect(provider.synthesize(baseRequest())).rejects.toBeInstanceOf(ProviderRequestError);
  });

  it("throws ProviderAuthError on a 401/403 response", async () => {
    process.env.ELEVENLABS_DEFAULT_VOICE_ID = "env-default-voice";
    mockFetchOnce({ ok: false, status: 401, text: async () => "unauthorized" } as unknown as Response);

    const provider = new ElevenLabsTtsProvider();
    await expect(provider.synthesize(baseRequest())).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it("throws ProviderRequestError on any other failed ElevenLabs API response", async () => {
    process.env.ELEVENLABS_DEFAULT_VOICE_ID = "env-default-voice";
    mockFetchOnce({ ok: false, status: 500, text: async () => "server error" } as unknown as Response);

    const provider = new ElevenLabsTtsProvider();
    await expect(provider.synthesize(baseRequest())).rejects.toBeInstanceOf(ProviderRequestError);
  });

  it("throws ProviderRequestError on a network failure", async () => {
    process.env.ELEVENLABS_DEFAULT_VOICE_ID = "env-default-voice";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ENOTFOUND api.elevenlabs.io");
      }),
    );

    const provider = new ElevenLabsTtsProvider();
    await expect(provider.synthesize(baseRequest())).rejects.toBeInstanceOf(ProviderRequestError);
  });
});
