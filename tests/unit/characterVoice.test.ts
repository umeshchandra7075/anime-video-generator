import { describe, it, expect } from "vitest";
import {
  resolveCharacterVoice,
  parseCharacterVoiceConfig,
  NATURAL_ANIME_DIALOGUE_DEFAULTS,
} from "@/lib/domain/characterVoice";

describe("resolveCharacterVoice", () => {
  it("uses the character's own voiceId/modelId when set", () => {
    const resolved = resolveCharacterVoice(
      { voiceId: "char-voice-123", modelId: "eleven_turbo_v2" },
      { defaultVoiceId: "env-default-voice", defaultModelId: "eleven_multilingual_v2" },
    );

    expect(resolved.voiceId).toBe("char-voice-123");
    expect(resolved.modelId).toBe("eleven_turbo_v2");
  });

  it("falls back to ELEVENLABS_DEFAULT_VOICE_ID when the character has no voiceId", () => {
    const resolved = resolveCharacterVoice(
      { stability: 0.9 }, // config present, but no voiceId
      { defaultVoiceId: "env-default-voice", defaultModelId: "eleven_multilingual_v2" },
    );

    expect(resolved.voiceId).toBe("env-default-voice");
    expect(resolved.stability).toBe(0.9); // per-field override still applies
  });

  it("falls back to ELEVENLABS_DEFAULT_VOICE_ID when the character has no config at all", () => {
    const resolved = resolveCharacterVoice(null, {
      defaultVoiceId: "env-default-voice",
      defaultModelId: "eleven_multilingual_v2",
    });

    expect(resolved.voiceId).toBe("env-default-voice");
    expect(resolved.modelId).toBe("eleven_multilingual_v2");
  });

  it("leaves voiceId undefined when neither the character nor the env default provide one", () => {
    const resolved = resolveCharacterVoice({}, {});
    expect(resolved.voiceId).toBeUndefined();
  });

  it("defaults modelId to eleven_multilingual_v2 when nothing else is configured", () => {
    const resolved = resolveCharacterVoice({}, {});
    expect(resolved.modelId).toBe("eleven_multilingual_v2");
  });

  it("uses natural anime-dialogue defaults for stability/similarityBoost/style/speed when unset", () => {
    const resolved = resolveCharacterVoice({}, {});
    expect(resolved.stability).toBe(NATURAL_ANIME_DIALOGUE_DEFAULTS.stability);
    expect(resolved.similarityBoost).toBe(NATURAL_ANIME_DIALOGUE_DEFAULTS.similarityBoost);
    expect(resolved.style).toBe(NATURAL_ANIME_DIALOGUE_DEFAULTS.style);
    expect(resolved.speed).toBe(NATURAL_ANIME_DIALOGUE_DEFAULTS.speed);
  });

  it("resolves every field independently (mixing overrides and defaults)", () => {
    const resolved = resolveCharacterVoice({ style: 0.1 }, { defaultVoiceId: "env-voice" });
    expect(resolved.style).toBe(0.1);
    expect(resolved.stability).toBe(NATURAL_ANIME_DIALOGUE_DEFAULTS.stability);
    expect(resolved.voiceId).toBe("env-voice");
  });
});

describe("parseCharacterVoiceConfig", () => {
  it("parses a JSON-encoded config", () => {
    const parsed = parseCharacterVoiceConfig(JSON.stringify({ voiceId: "abc", speed: 1.1 }));
    expect(parsed).toEqual({ voiceId: "abc", speed: 1.1 });
  });

  it("returns an empty object for null/undefined/malformed input", () => {
    expect(parseCharacterVoiceConfig(null)).toEqual({});
    expect(parseCharacterVoiceConfig(undefined)).toEqual({});
    expect(parseCharacterVoiceConfig("{not valid json")).toEqual({});
  });
});
