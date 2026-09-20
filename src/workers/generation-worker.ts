import os from "os";
import crypto from "crypto";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  claimNextJob,
  heartbeat,
  isCancelRequested,
  markStage,
  markCompleted,
  markFailed,
  markCancelled,
  requeueForRetry,
  recoverStaleJobs,
} from "@/lib/pipeline/jobTracking";
import { refundCredits, creditCostForDuration } from "@/lib/usage/creditService";
import { runStoryAnalysis } from "@/lib/pipeline/storyAnalysisStage";
import { createCharacters } from "@/lib/pipeline/characterStage";
import { createScenes, generateSceneImages } from "@/lib/pipeline/sceneStage";
import { generateSceneVoices, VoiceStageError } from "@/lib/pipeline/voiceStage";
import { generateSceneVideos } from "@/lib/pipeline/videoStage";
import { generateSceneLipSync } from "@/lib/pipeline/lipSyncStage";
import { generateProjectMusic } from "@/lib/pipeline/musicStage";
import { generateSubtitles } from "@/lib/pipeline/subtitleStage";
import { compositeFinalVideo } from "@/lib/pipeline/compositeStage";
import { ProviderNotConfiguredError, ProviderRequestError } from "@/lib/ai/errors/provider-errors";

const POLL_INTERVAL_MS = Number(process.env.GENERATION_WORKER_POLL_MS ?? "2000");
const HEARTBEAT_INTERVAL_MS = Number(process.env.GENERATION_WORKER_HEARTBEAT_MS ?? "20000");
const LEASE_DURATION_MS = Number(process.env.GENERATION_WORKER_LEASE_MS ?? "90000");
const STALE_RECOVERY_INTERVAL_MS = Number(process.env.GENERATION_WORKER_RECOVERY_MS ?? "30000");
const CONCURRENCY = Number(process.env.GENERATION_WORKER_CONCURRENCY ?? "2");

const WORKER_ID = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

/** Reports sub-stage progress from completed work, at most once per whole percent (no timers, no invented numbers). */
function makeProgressReporter(jobId: string) {
  const last = new Map<string, number>();
  return (stage: string, from: number, to: number, fraction: number, message: string) => {
    const pct = Math.round(from + Math.min(1, Math.max(0, fraction)) * (to - from));
    if (last.get(stage) === pct) return;
    last.set(stage, pct);
    return markStage(jobId, stage, pct, message).catch((err: unknown) => logger.warn({ err, jobId, stage }, "progress_update_failed"));
  };
}

function timelineDuration(raw: string | null): number | null {
  if (!raw) return null;
  try { const d = (JSON.parse(raw) as { duration?: unknown }).duration; return typeof d === "number" && d > 0 ? d : null; } catch { return null; }
}

/** Thrown internally to unwind the pipeline as soon as cancellation is observed. */
class JobCancelledSignal extends Error {}

async function checkCancelledOrThrow(jobId: string) {
  if (await isCancelRequested(jobId)) {
    throw new JobCancelledSignal();
  }
}

async function processJob(jobId: string, projectId: string, attemptCount: number, maxAttempts: number) {
  const stopHeartbeat = startHeartbeatLoop(jobId);

  try {
    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project) throw new Error(`Project ${projectId} no longer exists.`);

    await db.project.update({ where: { id: projectId }, data: { status: "PROCESSING" } });

    await checkCancelledOrThrow(jobId);
    await markStage(jobId, "story_analysis", 10, "Analyzing story...");
    const structured = await runStoryAnalysis(project);
    type SceneRow = Awaited<ReturnType<typeof createScenes>>[number];

    await checkCancelledOrThrow(jobId);
    await markStage(jobId, "characters", 20, "Generating character references...");
    const characters = await createCharacters(projectId, project.animeStyle, structured);

    await checkCancelledOrThrow(jobId);
    await markStage(jobId, "storyboard", 30, "Building storyboard...");
    let scenes = await createScenes(projectId, structured, characters);
    await generateSceneImages(
      projectId,
      scenes.map((s: SceneRow) => ({ id: s.id, imagePrompt: s.imagePrompt, sceneNumber: s.sceneNumber })),
    );

    // AUDIO FIRST: every dialogue line is synthesised with its speaker's own voice and its real duration is measured
    // BEFORE anything is animated. The result is each scene's authoritative master timeline (Scene.timeline);
    // animation, lip-sync, camera, SFX, subtitles and render all read it instead of estimating timing themselves.
    await checkCancelledOrThrow(jobId);
    await markStage(jobId, "voice", 40, "Generating per-character voices and measuring audio...");
    const throttled = makeProgressReporter(jobId);
    await generateSceneVoices(
      projectId,
      scenes.map((s: SceneRow) => ({
        id: s.id, sceneNumber: s.sceneNumber, narration: s.narration, dialogue: s.dialogue,
        description: s.description, location: s.location, mood: s.mood, cameraAngle: s.cameraAngle, cameraMovement: s.cameraMovement,
        soundEffects: s.soundEffects, musicMood: s.musicMood, characterIds: s.characterIds, estimatedSeconds: s.estimatedSeconds,
      })),
      project.language,
      project.voiceGender as "male" | "female" | "neutral",
      project.voiceStyle,
      characters.map((c) => ({ id: c.id, name: c.name, gender: c.gender, voiceConfig: c.voiceConfig })),
      { jobId, onProgress: (f) => throttled("voice", 40, 52, f, "Generating per-character voices and measuring audio...") },
    );
    // Re-read: the voice stage stored each scene's timeline and audio-derived estimatedSeconds.
    scenes = await db.scene.findMany({ where: { projectId }, orderBy: { orderIndex: "asc" } });

    await checkCancelledOrThrow(jobId);
    await markStage(jobId, "animation", 55, "Generating animation...");
    await generateSceneVideos(
      projectId,
      scenes.map((s: SceneRow) => ({
        id: s.id,
        sceneNumber: s.sceneNumber,
        animationPrompt: s.animationPrompt,
        animationNegativePrompt: s.animationNegativePrompt,
        imagePrompt: s.imagePrompt,
        description: s.description,
        cameraMovement: s.cameraMovement,
        lighting: s.lighting,
        characterIds: s.characterIds,
        estimatedSeconds: s.estimatedSeconds, // audio-derived (rounded up) - the clip is requested at the length the dialogue needs
        hasTimeline: !!s.timeline,
      })),
      project.aspectRatio as "16:9" | "9:16" | "1:1",
      characters.map((c) => ({
        id: c.id,
        name: c.name,
        appearance: c.appearance,
        hair: c.hair,
        clothes: c.clothes,
      })),
      jobId,
    );

    await checkCancelledOrThrow(jobId);
    await markStage(jobId, "lip_sync", 65, "Building lip-sync from the audio timeline...");
    await generateSceneLipSync(
      projectId,
      scenes.map((s: SceneRow) => ({ id: s.id, sceneNumber: s.sceneNumber, timeline: s.timeline, componentIssues: s.componentIssues })),
      characters.map((c: (typeof characters)[number]) => ({ id: c.id, name: c.name, providerMetadata: c.providerMetadata })),
      jobId,
      { onProgress: (f) => throttled("lip_sync", 65, 74, f, "Building lip-sync from the audio timeline...") },
    );
    scenes = await db.scene.findMany({ where: { projectId }, orderBy: { orderIndex: "asc" } }); // pick up per-scene lip-sync status

    await checkCancelledOrThrow(jobId);
    await markStage(jobId, "music", 75, "Generating music (sound effects are placed from each scene's timeline)...");
    const totalDuration = scenes.reduce((sum: number, s: SceneRow) => sum + (timelineDuration(s.timeline) ?? s.estimatedSeconds ?? 5), 0);
    await generateProjectMusic(projectId, project.musicMood ?? "none", totalDuration, jobId);

    if (project.subtitlesOn) {
      await checkCancelledOrThrow(jobId);
      await markStage(jobId, "subtitles", 85, "Creating subtitles from the timeline...");
      await generateSubtitles(
        projectId,
        project.subtitleLang || project.language,
        scenes.map((s: SceneRow) => ({
          sceneNumber: s.sceneNumber,
          narration: s.narration,
          dialogue: s.dialogue,
          estimatedSeconds: s.estimatedSeconds,
          timeline: s.timeline,
        })),
      );
    }

    await checkCancelledOrThrow(jobId);
    await markStage(jobId, "rendering", 90, "Rendering final video...");
    const { storageKey, durationSeconds, fileSizeBytes, settings } = await compositeFinalVideo(
      projectId,
      scenes.map((s: SceneRow) => ({ id: s.id, sceneNumber: s.sceneNumber, timeline: s.timeline })),
      project.subtitlesOn ? project.subtitleLang || project.language : undefined,
      { aspectRatio: project.aspectRatio, onProgress: (f) => throttled("rendering", 90, 99, f, "Rendering final video...") },
    );

    await db.videoAsset.create({
      data: {
        projectId,
        storageKey,
        durationSecs: Math.round(durationSeconds),
        fileSizeBytes,
        // The REAL rendered geometry (validated by ffprobe before we got here), not a label derived from the aspect ratio.
        resolution: `${settings.width}x${settings.height}`,
        format: "mp4",
      },
    });

    await markCompleted(jobId, projectId);
    logger.info({ projectId, jobId }, "generation_job_completed");
  } catch (err) {
    if (err instanceof JobCancelledSignal) {
      await markCancelled(jobId, projectId);
      const project = await db.project.findUnique({ where: { id: projectId } });
      if (project) {
        await refundCredits({
          userId: project.userId,
          amount: creditCostForDuration(project.duration),
          reason: `refund:cancel:${projectId}`,
        }).catch((refundErr) => logger.error({ refundErr, projectId }, "credit_refund_failed"));
      }
      return;
    }

    await handleFailure(jobId, projectId, attemptCount, maxAttempts, err);
  } finally {
    stopHeartbeat();
  }
}

function startHeartbeatLoop(jobId: string): () => void {
  const interval = setInterval(() => {
    heartbeat(jobId, WORKER_ID, LEASE_DURATION_MS).catch((err) =>
      logger.error({ err, jobId }, "heartbeat_failed"),
    );
  }, HEARTBEAT_INTERVAL_MS);
  return () => clearInterval(interval);
}

async function handleFailure(
  jobId: string,
  projectId: string,
  attemptCount: number,
  maxAttempts: number,
  err: unknown,
) {
  let code = "GENERATION_PROVIDER_ERROR";
  let message = "Video generation failed.";
  let retryable = true;

  if (err instanceof VoiceStageError) {
    // Already a clear, user-facing message (e.g. "ElevenLabs API key is not configured.").
    code = err.code;
    message = err.message;
    retryable = err.retryable;
  } else if (err instanceof ProviderNotConfiguredError) {
    code = "PROVIDER_NOT_CONFIGURED";
    message = `The ${err.provider} provider is not configured. Set the required environment variables to enable it.`;
    retryable = false; // retrying won't help until an operator fixes configuration
  } else if (err instanceof ProviderRequestError) {
    code = "GENERATION_PROVIDER_ERROR";
    message = "The AI provider was temporarily unavailable.";
  } else if (err instanceof Error) {
    message = err.message;
  }

  if (retryable && attemptCount < maxAttempts) {
    await requeueForRetry(jobId, attemptCount, message);
    logger.warn({ jobId, projectId, attemptCount, maxAttempts }, "generation_job_retry_scheduled");
    return;
  }

  await markFailed(jobId, projectId, code, message);

  const project = await db.project.findUnique({ where: { id: projectId } });
  if (project) {
    await refundCredits({
      userId: project.userId,
      amount: creditCostForDuration(project.duration),
      reason: `refund:generate:${projectId}`,
    }).catch((refundErr) => logger.error({ refundErr, projectId }, "credit_refund_failed"));
  }
}

/**
 * The worker's whole life cycle: on startup, recover any jobs left mid-flight
 * by a previous (crashed/killed) worker process, then loop forever claiming
 * and processing available work. This is a plain polling loop rather than a
 * push-based subscriber so it needs nothing beyond the database to run - no
 * Redis required for local development (see src/lib/queue/jobQueueAdapter.ts
 * for the optional low-latency production path).
 */
export function startGenerationWorker() {
  let shuttingDown = false;
  let activeCount = 0;

  logger.info({ workerId: WORKER_ID, concurrency: CONCURRENCY }, "generation_worker_starting");

  recoverStaleJobs().catch((err) => logger.error({ err }, "startup_stale_recovery_failed"));
  const recoveryTimer = setInterval(() => {
    recoverStaleJobs().catch((err) => logger.error({ err }, "periodic_stale_recovery_failed"));
  }, STALE_RECOVERY_INTERVAL_MS);

  const pollTimer = setInterval(async () => {
    if (shuttingDown || activeCount >= CONCURRENCY) return;
    try {
      const claimed = await claimNextJob(WORKER_ID, LEASE_DURATION_MS);
      if (!claimed) return;

      activeCount += 1;
      logger.info({ jobId: claimed.id, projectId: claimed.projectId, workerId: WORKER_ID }, "job_claimed");
      processJob(claimed.id, claimed.projectId, claimed.attemptCount, claimed.maxAttempts)
        .catch((err) => logger.error({ err, jobId: claimed.id }, "unhandled_job_error"))
        .finally(() => {
          activeCount -= 1;
        });
    } catch (err) {
      logger.error({ err }, "poll_loop_error");
    }
  }, POLL_INTERVAL_MS);

  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "generation_worker_shutting_down");
    clearInterval(pollTimer);
    clearInterval(recoveryTimer);

    // Give in-flight jobs a chance to reach their next checkpoint gracefully
    // rather than killing them mid-write; their lease will simply expire and
    // be recovered by another worker if they don't finish in time.
    const deadline = Date.now() + 10_000;
    while (activeCount > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    await db.$disconnect().catch(() => {});
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  return { workerId: WORKER_ID, stop: () => shutdown("manual") };
}

// Allow running as a standalone process: `npm run worker:generation`
if (require.main === module) {
  startGenerationWorker();
}
