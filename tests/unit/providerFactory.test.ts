import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ProviderFactory } from "@/lib/ai/factory/provider-factory";
import { ProviderNotConfiguredError } from "@/lib/ai/errors/provider-errors";

describe("ProviderFactory - music (unconfigured by default)", () => {
  beforeEach(() => {
    delete process.env.MUSIC_PROVIDER;
  });

  it("throws ProviderNotConfiguredError instead of faking a music result", async () => {
    const provider = ProviderFactory.getMusicProvider();
    await expect(
      provider.submit({ mood: "cinematic", durationSeconds: 60, kind: "music" }),
    ).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });
});

describe("ProviderFactory - video (FFmpeg fallback by default, real AI provider when configured)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.VIDEO_PROVIDER;
    delete process.env.VIDEO_PROVIDER_API_KEY;
    delete process.env.VIDEO_PROVIDER_BASE_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns the local FFmpeg provider when VIDEO_PROVIDER is unset - never faking or hard-failing", () => {
    const provider = ProviderFactory.getVideoProvider();
    expect(provider.name).toBe("ffmpeg");
  });

  it("returns a real AI video provider distinct from FFmpeg when VIDEO_PROVIDER is set", () => {
    process.env.VIDEO_PROVIDER = "runway";
    const provider = ProviderFactory.getVideoProvider();
    expect(provider.name).not.toBe("ffmpeg");
    expect(provider.name).toBe("runway");
  });

  it("the configured AI video provider still requires its own API key/base URL to actually run", async () => {
    process.env.VIDEO_PROVIDER = "runway";
    const provider = ProviderFactory.getVideoProvider();
    await expect(
      provider.submit({ prompt: "test", durationSeconds: 5, aspectRatio: "16:9" }),
    ).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });

  it("getFfmpegFallbackProvider() always returns FFmpeg regardless of VIDEO_PROVIDER", () => {
    process.env.VIDEO_PROVIDER = "runway";
    expect(ProviderFactory.getFfmpegFallbackProvider().name).toBe("ffmpeg");
  });
});

describe("ProviderFactory - lip sync (unconfigured by default, no local fallback)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.LIPSYNC_PROVIDER;
    delete process.env.LIPSYNC_PROVIDER_API_KEY;
    delete process.env.LIPSYNC_PROVIDER_BASE_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("throws ProviderNotConfiguredError instead of faking a lip-synced clip when LIPSYNC_PROVIDER is unset", async () => {
    const provider = ProviderFactory.getLipSyncProvider();
    await expect(
      provider.submit({ imageBase64: "abc", audioBase64: "def", audioMimeType: "audio/mpeg" }),
    ).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });

  it("returns a real HTTP lip-sync provider distinct from 'unconfigured' when LIPSYNC_PROVIDER is set", () => {
    process.env.LIPSYNC_PROVIDER = "syncso";
    const provider = ProviderFactory.getLipSyncProvider();
    expect(provider.name).toBe("syncso");
  });

  it("the configured lip-sync provider still requires its own API key/base URL to actually run", async () => {
    process.env.LIPSYNC_PROVIDER = "syncso";
    const provider = ProviderFactory.getLipSyncProvider();
    await expect(
      provider.submit({ imageBase64: "abc", audioBase64: "def", audioMimeType: "audio/mpeg" }),
    ).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });
});
