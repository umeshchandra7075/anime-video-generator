import path from "path";
import os from "os";
import fs from "fs/promises";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { ProviderFactory } from "@/lib/ai/factory/provider-factory";
import { downloadObject, uploadObject, projectStorageKey } from "@/lib/storage/objectStorage";
import {
  ProviderAuthError,
  ProviderNotConfiguredError,
  ProviderRequestError,
  ProviderTimeoutError,
} from "@/lib/ai/errors/provider-errors";
import { toJson, fromJson } from "@/lib/domain/json";
import { SceneStatus } from "@/lib/domain/enums";
import { validateFinalVideo } from "@/lib/pipeline/ffprobe";
import type { VideoProvider, VideoGenerationRequest, VideoJobResult } from "@/lib/ai/interfaces/video-provider";

const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes per scene, then treat as failed/timed out

export interface VideoSceneInput {
  id: string;
  sceneNumber: number;
  animationPrompt: string | null;
  animationNegativePrompt: string | null;
  imagePrompt: string | null;
  description: string | null;
  cameraMovement: string | null;
  lighting: string | null;
  characterIds: string | null; // JSON-encoded string[] - see src/lib/domain/json.ts
  estimatedSeconds: number | null;
  /** True when the scene already has an audio-derived master timeline: its duration is authoritative and must
   * NOT be overwritten by the provider clip's length (the renderer holds/trims the clip to the audio). */
  hasTimeline?: boolean;
}

// Narrow shape instead of the full Prisma `Character` model (same pattern
// as VoiceCharacterInput in voiceStage.ts / SceneCharacterInput in sceneStage.ts).
export interface VideoCharacterInput {
  id: string;
  name: string;
  appearance?: string | null;
  hair?: string | null;
  clothes?: string | null;
}

/**
 * ENABLE_FFMPEG_VIDEO_FALLBACK (default true, see .env.example): whether a
 * failure of the configured AI video provider (VIDEO_PROVIDER) should be
 * caught and automatically retried with the local FFmpeg Ken-Burns
 * provider instead of failing the generation job. Set to "false" to make
 * an AI provider failure fail the whole job instead (strict mode).
 *
 * When VIDEO_PROVIDER is unset in the first place, ProviderFactory already
 * hands back the FFmpeg provider directly (see provider-factory.ts) - this
 * flag only matters once an AI provider is actually configured.
 */
function isFfmpegFallbackEnabled(): boolean {
  return process.env.ENABLE_FFMPEG_VIDEO_FALLBACK !== "false";
}

const DEFAULT_NEGATIVE_PROMPT =
  "character face changing between frames, hairstyle changing, clothing or outfit " +
  "colors changing, inconsistent character identity, extra limbs, extra fingers, " +
  "distorted or deformed hands, missing limbs, frozen static pose, no motion, " +
  "still image, sudden camera cut, jump cut, teleporting characters, warped " +
  "anatomy, disfigured face, blurry, low quality, watermark, text artifacts, " +
  "flickering, morphing background.";

function buildCharacterInfo(characterIds: string[], characters: VideoCharacterInput[]): string | undefined {
  if (characterIds.length === 0 || characters.length === 0) return undefined;
  const idSet = new Set(characterIds);
  const relevant = characters.filter((c) => idSet.has(c.id));
  if (relevant.length === 0) return undefined;

  return relevant
    .map((c) => {
      const traits = [c.appearance, c.hair, c.clothes].filter(Boolean).join(", ");
      return traits ? `${c.name} (keep consistent: ${traits})` : c.name;
    })
    .join("; ");
}

/** Fallback prompt composition used only when Gemini didn't populate a
 * scene's animationPrompt (see improved SYSTEM_PROMPT in
 * gemini-text-provider.ts, which normally produces a rich, structured
 * ACTION/FACIAL/ENVIRONMENT/CAMERA/MOTION prompt already). */
function composeFallbackAnimationPrompt(scene: VideoSceneInput): string {
  const parts = [
    scene.description ? `ACTION: ${scene.description}` : null,
    "MOTION: Continuous natural anime motion, fluid character animation, consistent anatomy, no frozen poses.",
    scene.cameraMovement ? `CAMERA: ${scene.cameraMovement}.` : null,
    scene.lighting ? `LIGHTING: ${scene.lighting}.` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "Anime scene animation with natural character motion.";
}

/**
 * Generates one animated video clip per scene using a real AI video
 * provider when VIDEO_PROVIDER is configured (see
 * src/lib/ai/providers/video/ai-video-provider.ts), automatically falling
 * back to the local FFmpeg Ken-Burns provider if the AI provider fails
 * (recoverably) or isn't configured at all - see isFfmpegFallbackEnabled().
 *
 * Every downloaded clip is independently validated with the same local
 * ffprobe-based check used for the final render (src/lib/pipeline/ffprobe.ts)
 * before it's trusted and stored - a provider reporting "completed" is not
 * enough on its own. If the AI provider's actual clip duration differs from
 * the scene's planned duration and the scene has NO master timeline yet
 * (legacy order), estimatedSeconds is updated to the real duration. Scenes
 * that already have a timeline (audio-first: see voiceStage.ts) keep their
 * audio-derived duration; the renderer holds or trims the clip to fit it.
 *
 * Idempotent: scenes that already have a VIDEO_CLIP asset are skipped.
 */
export async function generateSceneVideos(
  projectId: string,
  scenes: VideoSceneInput[],
  aspectRatio: "16:9" | "9:16" | "1:1",
  characters: VideoCharacterInput[] = [],
  jobId?: string,
) {
  const primaryProvider = ProviderFactory.getVideoProvider();
  const ffmpegProvider = ProviderFactory.getFfmpegFallbackProvider();
  const usingRealAiProvider = primaryProvider.name !== ffmpegProvider.name;

  for (const scene of scenes) {
    const existingClip = await db.sceneAsset.findFirst({ where: { sceneId: scene.id, type: "VIDEO_CLIP" } });
    if (existingClip) continue;

    const imageAsset = await db.sceneAsset.findFirst({
      where: { sceneId: scene.id, type: "IMAGE" },
      orderBy: { createdAt: "desc" },
    });

    let referenceImageBase64: string | undefined;
    if (imageAsset) {
      const buffer = await downloadObject(imageAsset.storageKey).catch(() => null);
      if (buffer) referenceImageBase64 = buffer.toString("base64");
    }

    await db.scene.update({ where: { id: scene.id }, data: { status: SceneStatus.PROCESSING } });

    const characterIds = fromJson<string[]>(scene.characterIds, []);
    const request: VideoGenerationRequest = {
      prompt: scene.animationPrompt || composeFallbackAnimationPrompt(scene) || scene.imagePrompt || "Anime scene animation.",
      referenceImageBase64,
      durationSeconds: scene.estimatedSeconds ?? 5,
      aspectRatio,
      negativePrompt: scene.animationNegativePrompt || DEFAULT_NEGATIVE_PROMPT,
      characterInfo: buildCharacterInfo(characterIds, characters),
    };

    try {
      let clip: Awaited<ReturnType<typeof runProviderToCompletion>>;
      let providerName: string;
      let fallbackReason: string | undefined;

      try {
        clip = await runProviderToCompletion(primaryProvider, request);
        providerName = primaryProvider.name;
      } catch (primaryError) {
        // No separate AI provider configured (primary === ffmpeg fallback
        // already), or fallback is explicitly disabled: nothing left to
        // fall back to - let the original error propagate as before.
        if (!usingRealAiProvider || !isFfmpegFallbackEnabled()) {
          throw primaryError;
        }

        fallbackReason = classifyFallbackReason(primaryError);
        const errorMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
        logger.warn(
          { projectId, sceneId: scene.id, provider: primaryProvider.name, fallbackReason, error: errorMessage },
          "video_provider_failed_falling_back_to_ffmpeg",
        );
        await logJobEvent(
          jobId,
          `Scene ${scene.sceneNumber}: ${primaryProvider.name} animation failed (${fallbackReason}) - using FFmpeg fallback.`,
        );

        clip = await runProviderToCompletion(ffmpegProvider, request);
        providerName = ffmpegProvider.name;
      }

      const key = projectStorageKey(projectId, "scenes", `${scene.sceneNumber}`, "clip.mp4");
      await uploadObject(key, clip.buffer, clip.mimeType);

      const plannedDuration = scene.estimatedSeconds ?? 5;
      const durationDrifted =
        providerName !== ffmpegProvider.name && Math.abs(clip.durationSeconds - plannedDuration) > 0.5;

      const updates = [
        db.sceneAsset.create({
          data: {
            sceneId: scene.id,
            type: "VIDEO_CLIP",
            storageKey: key,
            providerName,
            providerJobId: clip.providerJobId,
            providerMetadata: toJson({
              ...(clip.providerMetadata ?? {}),
              validationMethod: clip.validationMethod,
              validatedDurationSeconds: clip.durationSeconds,
              negativePrompt: request.negativePrompt,
              characterInfo: request.characterInfo ?? null,
              ...(fallbackReason ? { fallbackReason } : {}),
            }),
          },
        }),
        db.scene.update({
          where: { id: scene.id },
          data: {
            status: SceneStatus.COMPLETED,
            ...(durationDrifted && !scene.hasTimeline ? { estimatedSeconds: Math.round(clip.durationSeconds) } : {}),
          },
        }),
      ];
      await db.$transaction(updates);

      if (fallbackReason) {
        await logJobEvent(jobId, `Scene ${scene.sceneNumber}: animated with FFmpeg fallback.`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Scene video generation failed.";
      await db.scene.update({
        where: { id: scene.id },
        data: { status: SceneStatus.FAILED, errorMessage: message, retryCount: { increment: 1 } },
      });
      throw err;
    }
  }
}

interface CompletedClip {
  buffer: Buffer;
  mimeType: string;
  durationSeconds: number;
  providerJobId?: string;
  providerMetadata?: Record<string, unknown>;
  validationMethod: string;
}

/** Submits a request to a VideoProvider, polls it to completion (handling
 * queued/processing/completed/failed/timeout - see pollUntilDone), and
 * independently validates the downloaded MP4 with ffprobe before trusting
 * it. Throws a ProviderRequestError on any failure so the caller has one
 * uniform error path regardless of which provider (AI or FFmpeg) was used. */
async function runProviderToCompletion(
  provider: VideoProvider,
  request: VideoGenerationRequest,
): Promise<CompletedClip> {
  const handle = await provider.submit(request);
  const result = await pollUntilDone(provider, handle.providerJobId);

  if (result.status !== "completed" || !result.videoBase64) {
    throw new ProviderRequestError(
      provider.name,
      result.errorMessage ?? `${provider.name} did not return a completed video clip.`,
    );
  }

  const buffer = Buffer.from(result.videoBase64, "base64");
  const validated = await validateDownloadedClip(buffer, provider.name);

  return {
    buffer,
    mimeType: result.mimeType ?? "video/mp4",
    durationSeconds: validated.durationSeconds,
    providerJobId: handle.providerJobId,
    providerMetadata: result.providerMetadata,
    validationMethod: validated.method,
  };
}

/** Requirement: "validate the generated MP4 using the existing FFprobe
 * validation" - reuses validateFinalVideo from ffprobe.ts (unmodified)
 * against a temp copy of the downloaded clip, rather than trusting the
 * provider's "completed" status alone. */
async function validateDownloadedClip(
  buffer: Buffer,
  providerName: string,
): Promise<{ durationSeconds: number; method: string }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "avg-clip-validate-"));
  const tmpFile = path.join(tmpDir, "clip.mp4");
  try {
    await fs.writeFile(tmpFile, buffer);
    const result = await validateFinalVideo(tmpFile);
    if (!result.ok) {
      throw new ProviderRequestError(providerName, `Generated clip failed FFprobe validation: ${result.reason}`);
    }
    return { durationSeconds: result.durationSeconds, method: result.method };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function pollUntilDone(provider: VideoProvider, providerJobId: string): Promise<VideoJobResult> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const result = await provider.getStatus(providerJobId);
    // queued / processing: keep waiting. completed / failed / cancelled: done.
    if (result.status === "completed" || result.status === "failed" || result.status === "cancelled") {
      return result;
    }
    if (Date.now() > deadline) {
      return { status: "failed", errorMessage: `${provider.name} video generation timed out.` };
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Maps a caught error from the primary AI video provider to a short
 * machine-readable reason code, stored in SceneAsset.providerMetadata /
 * job events. Mirrors classifyFallbackReason in musicStage.ts. */
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
    if (/timed out|timeout/i.test(error.message)) return "TIMEOUT";
    if (/validation/i.test(error.message)) return "INVALID_OUTPUT";
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
  await db.jobEvent.create({ data: { jobId, stage: "animation", message } }).catch((err) => {
    // Best-effort only - a logging failure must never break the pipeline.
    logger.warn({ err, jobId }, "video_stage_job_event_write_failed");
  });
}
