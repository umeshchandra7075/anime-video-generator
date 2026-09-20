import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { ProviderFactory } from "@/lib/ai/factory/provider-factory";
import { uploadObject, projectStorageKey } from "@/lib/storage/objectStorage";
import { toJson } from "@/lib/domain/json";
import { MusicProvider, MusicGenerationRequest, MusicJobResult } from "@/lib/ai/interfaces/music-provider";
import {
  ProviderAuthError,
  ProviderNotConfiguredError,
  ProviderRequestError,
  ProviderTimeoutError,
} from "@/lib/ai/errors/provider-errors";

const POLL_INTERVAL_MS = 4000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * ENABLE_LOCAL_AUDIO_FALLBACK (default true, see .env.example): whether a
 * failure of the primary (paid) music provider should be caught and
 * automatically retried with the free local FFmpeg provider instead of
 * failing the generation job. Set to "false" to restore the old
 * fail-the-job behavior.
 */
function isLocalFallbackEnabled(): boolean {
  return process.env.ENABLE_LOCAL_AUDIO_FALLBACK !== "false";
}

/** Submits a request to a MusicProvider and polls it to completion, turning
 * a "failed"/timed-out job result into a thrown ProviderRequestError so
 * both the pollinations and local providers have one uniform failure path
 * for the caller to handle. */
async function runProviderToCompletion(
  provider: MusicProvider,
  request: MusicGenerationRequest,
): Promise<MusicJobResult> {
  const handle = await provider.submit(request);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let result: MusicJobResult;
  for (;;) {
    result = await provider.getStatus(handle.providerJobId);
    if (result.status === "completed" || result.status === "failed" || result.status === "cancelled") break;
    if (Date.now() > deadline) {
      result = { status: "failed", errorMessage: `${provider.name} audio generation timed out.` };
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  if (result.status !== "completed" || !result.audioBase64) {
    throw new ProviderRequestError(
      provider.name,
      result.errorMessage ?? `${provider.name} did not return a completed audio track.`,
    );
  }

  return result;
}

/**
 * Maps a caught error from the primary provider to a short machine-readable
 * reason code, stored in AudioAsset.providerMetadata.fallbackReason and
 * used in log lines / job events.
 */
function classifyFallbackReason(error: unknown): string {
  if (error instanceof ProviderNotConfiguredError) return "PROVIDER_NOT_CONFIGURED";
  if (error instanceof ProviderAuthError) return "UNAUTHORIZED";
  if (error instanceof ProviderTimeoutError) return "TIMEOUT";

  if (error instanceof ProviderRequestError) {
    const status = error.statusCode;
    if (status === 401) return "UNAUTHORIZED";
    if (status === 402) return "INSUFFICIENT_BALANCE";
    if (status === 403) return "FORBIDDEN";
    if (status === 429) return "RATE_LIMITED";
    if (status && status >= 500) return "PROVIDER_SERVER_ERROR";
    if (/insufficient[_\s-]?balance/i.test(error.message)) return "INSUFFICIENT_BALANCE";
    return "PROVIDER_REQUEST_ERROR";
  }

  if (error instanceof Error) {
    if (/timed out|timeout/i.test(error.message)) return "TIMEOUT";
    if (/network|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(error.message)) return "NETWORK_ERROR";
    return "PROVIDER_ERROR";
  }

  return "UNKNOWN_ERROR";
}

async function logJobEvent(jobId: string | undefined, message: string): Promise<void> {
  if (!jobId) return;
  await db.jobEvent.create({ data: { jobId, stage: "music", message } }).catch((err) => {
    // Best-effort only - a logging failure must never break the pipeline.
    logger.warn({ err, jobId }, "music_stage_job_event_write_failed");
  });
}

/**
 * Idempotent: skipped entirely if mood is "none", or if music already
 * exists for this project from a prior attempt.
 *
 * Tries the configured primary MusicProvider (Pollinations) first. If it
 * fails with a recoverable provider error - not configured, missing API
 * key, 401/402/403/429/5xx, timeout, or network error - and
 * ENABLE_LOCAL_AUDIO_FALLBACK is not explicitly "false", automatically
 * falls back to the free local FFmpeg-based provider so the pipeline can
 * always continue. This function never throws for a recoverable failure:
 * if even the local fallback fails, it logs and returns without creating a
 * MUSIC asset, so the video renders without background music rather than
 * failing the whole job. Set ENABLE_LOCAL_AUDIO_FALLBACK=false to restore
 * the old strict fail-the-job behavior.
 */
export async function generateProjectMusic(
  projectId: string,
  mood: string,
  totalDurationSeconds: number,
  jobId?: string,
): Promise<void> {
  if (mood === "none") return;

  const existing = await db.audioAsset.findFirst({ where: { projectId, type: "MUSIC" } });
  if (existing) return;

  const request: MusicGenerationRequest = { mood, durationSeconds: totalDurationSeconds, kind: "music" };
  const primaryProvider = ProviderFactory.getMusicProvider();

  let result: MusicJobResult;
  let providerName: string;
  let fallbackReason: string | undefined;

  try {
    result = await runProviderToCompletion(primaryProvider, request);
    providerName = primaryProvider.name;
  } catch (primaryError) {
    if (!isLocalFallbackEnabled()) {
      // Fallback explicitly disabled - preserve the original behavior of
      // letting the error bubble up and fail the job.
      throw primaryError;
    }

    fallbackReason = classifyFallbackReason(primaryError);
    const errorMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);

    logger.warn(
      { projectId, provider: primaryProvider.name, fallbackReason, error: errorMessage },
      "music_provider_failed_falling_back_to_local",
    );
    await logJobEvent(jobId, `Music provider unavailable (${fallbackReason}) - using local fallback audio.`);

    const localProvider = ProviderFactory.getLocalAudioFallbackProvider();
    try {
      result = await runProviderToCompletion(localProvider, request);
      providerName = localProvider.name;
    } catch (fallbackError) {
      // Even the free local fallback failed (e.g. the FFmpeg binary is
      // missing on this host). Per spec, music must never fail the whole
      // generation job - skip music entirely and continue the pipeline.
      // compositeStage already renders correctly with no MUSIC asset.
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      logger.error({ projectId, error: fallbackMessage }, "local_audio_fallback_also_failed_skipping_music");
      await logJobEvent(jobId, "Local audio fallback also failed - continuing without background music.");
      return;
    }
  }

  const key = projectStorageKey(projectId, "audio", "music.mp3");
  await uploadObject(key, Buffer.from(result.audioBase64 as string, "base64"), result.mimeType ?? "audio/mpeg");

  const providerMetadata: Record<string, unknown> = {
    ...(result.providerMetadata ?? {}),
    provider: providerName,
    ...(fallbackReason ? { fallbackReason } : {}),
  };

  await db.audioAsset.create({
    data: {
      projectId,
      type: "MUSIC",
      storageKey: key,
      providerName,
      providerMetadata: toJson(providerMetadata),
    },
  });

  if (fallbackReason) {
    await logJobEvent(jobId, "Music & sound effects ready (local fallback).");
  }
}
