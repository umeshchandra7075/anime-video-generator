import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { JobStatus, ProjectStatus } from "@/lib/domain/enums";

const DEFAULT_LEASE_MS = 90_000; // a worker must heartbeat at least this often or be presumed dead

export interface ClaimedJob {
  id: string;
  projectId: string;
  attemptCount: number;
  maxAttempts: number;
}

/**
 * Atomically claims one available job for this worker instance. Race-safe on
 * any SQL engine (including SQLite, which has no SELECT ... FOR UPDATE SKIP
 * LOCKED) because the claim is a single conditional UPDATE keyed on the row
 * still being in the state we last observed it in - if two workers race,
 * exactly one UPDATE affects a row and the other affects zero.
 */
export async function claimNextJob(leaseOwner: string, leaseDurationMs = DEFAULT_LEASE_MS): Promise<ClaimedJob | null> {
  const now = new Date();

  const candidate = await db.generationJob.findFirst({
    where: {
      status: { in: [JobStatus.QUEUED, JobStatus.RETRYING] },
      availableAt: { lte: now },
    },
    orderBy: { availableAt: "asc" },
  });
  if (!candidate) return null;

  const result = await db.generationJob.updateMany({
    where: { id: candidate.id, status: candidate.status },
    data: {
      status: JobStatus.PROCESSING,
      leaseOwner,
      leaseExpiresAt: new Date(Date.now() + leaseDurationMs),
      heartbeatAt: now,
      attemptCount: { increment: 1 },
    },
  });
  if (result.count === 0) return null; // another worker won the race

  const claimed = await db.generationJob.findUnique({ where: { id: candidate.id } });
  if (!claimed) return null;
  return { id: claimed.id, projectId: claimed.projectId, attemptCount: claimed.attemptCount, maxAttempts: claimed.maxAttempts };
}

export async function heartbeat(jobId: string, leaseOwner: string, leaseDurationMs = DEFAULT_LEASE_MS): Promise<void> {
  await db.generationJob.updateMany({
    where: { id: jobId, leaseOwner },
    data: { heartbeatAt: new Date(), leaseExpiresAt: new Date(Date.now() + leaseDurationMs) },
  });
}

export async function isCancelRequested(jobId: string): Promise<boolean> {
  const job = await db.generationJob.findUnique({ where: { id: jobId }, select: { cancelRequested: true } });
  return Boolean(job?.cancelRequested);
}

export async function markStage(jobId: string, stage: string, progress: number, message?: string): Promise<void> {
  await db.generationJob.update({
    where: { id: jobId },
    data: { currentStage: stage, progress, status: JobStatus.PROCESSING, heartbeatAt: new Date() },
  });
  await db.jobEvent.create({ data: { jobId, stage, message: message ?? null } });
  logger.info({ jobId, stage, progress }, "generation_stage_update");
}

export async function markCompleted(jobId: string, projectId: string): Promise<void> {
  await db.$transaction([
    db.generationJob.update({
      where: { id: jobId },
      data: {
        status: JobStatus.COMPLETED,
        progress: 100,
        currentStage: "finalizing",
        activeKey: null,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    }),
    db.project.update({ where: { id: projectId }, data: { status: ProjectStatus.COMPLETED } }),
  ]);
  await db.jobEvent.create({ data: { jobId, stage: "finalizing", message: "Video ready." } });
}

export async function markFailed(jobId: string, projectId: string, errorCode: string, errorMessage: string): Promise<void> {
  await db.$transaction([
    db.generationJob.update({
      where: { id: jobId },
      data: {
        status: JobStatus.FAILED,
        errorCode,
        errorMessage,
        activeKey: null,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    }),
    db.project.update({ where: { id: projectId }, data: { status: ProjectStatus.FAILED } }),
  ]);
  await db.jobEvent.create({ data: { jobId, stage: "failed", message: errorMessage } });
  logger.warn({ jobId, projectId, errorCode, errorMessage }, "generation_job_failed");
}

export async function markCancelled(jobId: string, projectId: string): Promise<void> {
  await db.$transaction([
    db.generationJob.update({
      where: { id: jobId },
      data: { status: JobStatus.CANCELLED, activeKey: null, leaseOwner: null, leaseExpiresAt: null },
    }),
    db.project.update({ where: { id: projectId }, data: { status: ProjectStatus.CANCELLED } }),
  ]);
  await db.jobEvent.create({ data: { jobId, stage: "cancelled", message: "Generation cancelled." } });
  logger.info({ jobId, projectId }, "generation_job_cancelled");
}

function backoffMs(attemptCount: number): number {
  return Math.min(60_000, 2_000 * 2 ** attemptCount);
}

/** Puts a job back in the queue for another attempt, with exponential backoff. */
export async function requeueForRetry(jobId: string, attemptCount: number, reason: string): Promise<void> {
  await db.generationJob.update({
    where: { id: jobId },
    data: {
      status: JobStatus.RETRYING,
      leaseOwner: null,
      leaseExpiresAt: null,
      availableAt: new Date(Date.now() + backoffMs(attemptCount)),
    },
  });
  await db.jobEvent.create({ data: { jobId, stage: "retry_scheduled", message: reason } });
}

/**
 * Finds jobs whose worker stopped heartbeating (crashed, killed, lost
 * connectivity) and either requeues them for another attempt or fails them
 * once attempts are exhausted. Safe to call on a timer and on worker
 * startup - this is what lets a job survive a worker restart.
 */
export async function recoverStaleJobs(): Promise<number> {
  const stale = await db.generationJob.findMany({
    where: { status: JobStatus.PROCESSING, leaseExpiresAt: { lt: new Date() } },
  });

  for (const job of stale) {
    if (job.attemptCount >= job.maxAttempts) {
      await markFailed(
        job.id,
        job.projectId,
        "WORKER_LOST",
        "The worker processing this job stopped responding and retry attempts were exhausted.",
      );
    } else {
      await requeueForRetry(job.id, job.attemptCount, "Worker heartbeat lost - requeued for retry.");
    }
  }

  if (stale.length > 0) logger.warn({ count: stale.length }, "recovered_stale_jobs");
  return stale.length;
}
