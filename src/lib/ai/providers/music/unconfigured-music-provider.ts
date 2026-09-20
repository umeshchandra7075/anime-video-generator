import { MusicProvider, MusicGenerationRequest, MusicJobHandle, MusicJobResult } from "@/lib/ai/interfaces/music-provider";
import { ProviderNotConfiguredError } from "@/lib/ai/errors/provider-errors";

/**
 * Default MusicProvider when MUSIC_PROVIDER is unset. See
 * unconfigured-video-provider.ts for the pattern to follow when wiring in a
 * real provider (e.g. music/suno-music-provider.ts, music/mubert-music-provider.ts).
 */
export class UnconfiguredMusicProvider implements MusicProvider {
  readonly name = "unconfigured";

  async submit(_request: MusicGenerationRequest): Promise<MusicJobHandle> {
    throw new ProviderNotConfiguredError("music");
  }

  async getStatus(_providerJobId: string): Promise<MusicJobResult> {
    throw new ProviderNotConfiguredError("music");
  }
}
