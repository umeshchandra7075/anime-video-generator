import { VideoProvider, VideoGenerationRequest, VideoJobHandle, VideoJobResult } from "@/lib/ai/interfaces/video-provider";
import { ProviderNotConfiguredError } from "@/lib/ai/errors/provider-errors";

/**
 * NOTE: no longer wired into ProviderFactory.getVideoProvider(). Real AI
 * animation is now provided by HttpVideoProvider
 * (src/lib/ai/providers/video/ai-video-provider.ts) when VIDEO_PROVIDER is
 * set, and ProviderFactory falls back to FfmpegVideoProvider directly
 * (never this class) when it's unset, so scene generation always has a
 * usable provider instead of hard-failing - see videoStage.ts and
 * ENABLE_FFMPEG_VIDEO_FALLBACK in .env.example. Kept here only as a
 * reference/utility for anyone who wants a strict "fail instead of
 * falling back" video provider in their own wiring.
 */
export class UnconfiguredVideoProvider implements VideoProvider {
  readonly name = "unconfigured";

  async submit(_request: VideoGenerationRequest): Promise<VideoJobHandle> {
    throw new ProviderNotConfiguredError("video");
  }

  async getStatus(_providerJobId: string): Promise<VideoJobResult> {
    throw new ProviderNotConfiguredError("video");
  }
}
