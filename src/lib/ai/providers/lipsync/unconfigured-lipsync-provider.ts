import {
  LipSyncProvider,
  LipSyncGenerationRequest,
  LipSyncJobHandle,
  LipSyncJobResult,
} from "@/lib/ai/interfaces/lipsync-provider";
import { ProviderNotConfiguredError } from "@/lib/ai/errors/provider-errors";

/**
 * Default lip-sync provider when LIPSYNC_PROVIDER is unset: throws instead
 * of fabricating a "synced" clip, mirroring UnconfiguredVideoProvider and
 * the music stage's honest-failure-then-fallback pattern. lipSyncStage.ts
 * catches ProviderNotConfiguredError specifically and treats it as "skip
 * lip sync for this project" rather than failing the job - the scene's
 * existing VIDEO_CLIP (real AI animation or FFmpeg Ken-Burns) is used as-is,
 * same as how a project renders without music when MUSIC_PROVIDER is unset.
 */
export class UnconfiguredLipSyncProvider implements LipSyncProvider {
  readonly name = "unconfigured";

  async submit(_request: LipSyncGenerationRequest): Promise<LipSyncJobHandle> {
    throw new ProviderNotConfiguredError("lipsync");
  }

  async getStatus(_providerJobId: string): Promise<LipSyncJobResult> {
    throw new ProviderNotConfiguredError("lipsync");
  }
}
