import { TextProvider } from "@/lib/ai/interfaces/text-provider";
import { ImageProvider } from "@/lib/ai/interfaces/image-provider";
import { TTSProvider } from "@/lib/ai/interfaces/tts-provider";
import { VideoProvider } from "@/lib/ai/interfaces/video-provider";
import { MusicProvider } from "@/lib/ai/interfaces/music-provider";
import { LipSyncProvider } from "@/lib/ai/interfaces/lipsync-provider";

import { GeminiTextProvider } from "@/lib/ai/providers/gemini/gemini-text-provider";
import { PollinationsImageProvider } from "@/lib/ai/providers/pollinations/pollinations-image-provider";
import { ElevenLabsTtsProvider } from "@/lib/ai/providers/elevenlabs/elevenlabs-tts-provider";
import { OpenAITtsProvider } from "@/lib/ai/providers/openai/openai-tts-provider";
import { ProviderRequestError } from "@/lib/ai/errors/provider-errors";
import { FfmpegVideoProvider } from "@/lib/ai/providers/video/ffmpeg-video-provider";
import { HttpVideoProvider } from "@/lib/ai/providers/video/ai-video-provider";
import { PollinationsMusicProvider } from "@/lib/ai/providers/pollinations/pollinations-music-provider";
import { LocalAudioProvider } from "@/lib/ai/providers/audio/local-audio-provider";
import { HttpLipSyncProvider } from "@/lib/ai/providers/lipsync/http-lipsync-provider";
import { UnconfiguredLipSyncProvider } from "@/lib/ai/providers/lipsync/unconfigured-lipsync-provider";

export const ProviderFactory = {
  getTextProvider(): TextProvider {
    return new GeminiTextProvider();
  },

  getImageProvider(): ImageProvider {
    return new PollinationsImageProvider();
  },

  /** TTS_PROVIDER: "elevenlabs" (default) | "openai". Google and Azure are recognised but NOT implemented:
   * selecting them fails loudly instead of silently falling back to another voice. */
  getTTSProvider(): TTSProvider {
    const choice = (process.env.TTS_PROVIDER || "elevenlabs").toLowerCase();
    if (choice === "openai") return new OpenAITtsProvider();
    if (choice === "google" || choice === "azure") {
      throw new ProviderRequestError(choice, `TTS provider "${choice}" is not implemented in this build. Use TTS_PROVIDER=elevenlabs or openai.`);
    }
    if (choice !== "elevenlabs") throw new ProviderRequestError(choice, `Unknown TTS_PROVIDER "${choice}". Use elevenlabs or openai.`);
    return new ElevenLabsTtsProvider();
  },

  /**
   * Real AI image-to-video generation when VIDEO_PROVIDER is set (see
   * src/lib/ai/providers/video/ai-video-provider.ts and its required
   * VIDEO_PROVIDER_API_KEY/VIDEO_PROVIDER_BASE_URL). Falls back to the
   * local FFmpeg Ken-Burns provider (zoom/pan over the still image) when
   * VIDEO_PROVIDER is unset, so scene video generation always has a
   * provider to call rather than failing outright - see
   * ENABLE_FFMPEG_VIDEO_FALLBACK / getFfmpegFallbackProvider() for the
   * mid-generation fallback used when a *configured* AI provider fails.
   */
  getVideoProvider(): VideoProvider {
    const providerName = (process.env.VIDEO_PROVIDER || "").trim();
    if (!providerName) return new FfmpegVideoProvider();
    return new HttpVideoProvider();
  },

  /** Always the local FFmpeg Ken-Burns provider, regardless of
   * VIDEO_PROVIDER - used by videoStage.ts as the fallback when the
   * configured AI video provider fails (see ENABLE_FFMPEG_VIDEO_FALLBACK
   * in .env.example), mirroring getLocalAudioFallbackProvider() below. */
  getFfmpegFallbackProvider(): VideoProvider {
    return new FfmpegVideoProvider();
  },

  getMusicProvider(): MusicProvider {
    return new PollinationsMusicProvider();
  },

  /**
   * Free, local, no-API-key fallback used by musicStage when the primary
   * music provider is unconfigured, out of balance, or otherwise fails with
   * a recoverable error (see ENABLE_LOCAL_AUDIO_FALLBACK in .env.example).
   */
  getLocalAudioFallbackProvider(): MusicProvider {
    return new LocalAudioProvider();
  },

  /**
   * Real audio-driven lip sync (viseme-accurate mouth movement, not a
   * canned open/closed loop) when LIPSYNC_PROVIDER is set - see
   * src/lib/ai/providers/lipsync/http-lipsync-provider.ts and its required
   * LIPSYNC_PROVIDER_API_KEY/LIPSYNC_PROVIDER_BASE_URL. There is no local,
   * dependency-free fallback for this stage the way there is for video/
   * music (real lip sync requires a trained model) - when unset,
   * lipSyncStage.ts skips lip sync for the project entirely and the
   * scene's existing VIDEO_CLIP is used as-is, exactly like a project
   * rendering without music when MUSIC_PROVIDER is unset.
   */
  getLipSyncProvider(): LipSyncProvider {
    const providerName = (process.env.LIPSYNC_PROVIDER || "").trim();
    if (!providerName) return new UnconfiguredLipSyncProvider();
    return new HttpLipSyncProvider();
  },
};