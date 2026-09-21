import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/context";
import { getOwnedProject } from "@/lib/domain/projectAccess";
import { reserveCredits } from "@/lib/usage/creditService";
import { getJobQueueAdapter } from "@/lib/queue/jobQueueFactory";
import { JobStatus, ProjectStatus, ACTIVE_JOB_STATUSES } from "@/lib/domain/enums";
import { ok, fail } from "@/lib/api/response";
import { Errors } from "@/lib/api/errors";
import { logger } from "@/lib/logger";

function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "P2002";
}
import { Prisma } from "@prisma/client";

interface Params {
  params: { id: string };
}

/**
 * Idempotent by design at two layers:
 *  1. Application-level: if a non-terminal job already exists for this
 *     project, hand it back instead of creating a new one.
 *  2. Database-level: GenerationJob.activeKey has a UNIQUE constraint and is
 *     set to the projectId while a job is non-terminal. Even if two requests
 *     race past check #1 (e.g. a double-click and a network retry landing
 *     at nearly the same instant), only one INSERT can win; the other gets
 *     a Prisma P2002 unique-constraint error, which we catch and resolve by
 *     returning the winning job. This closes the race that a plain
 *     check-then-act can't.
 */
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const ctx = await requireAuth(req);
    const project = await getOwnedProject(params.id, ctx.userId);

    const inFlight = await db.generationJob.findFirst({
      where: { projectId: project.id, status: { in: ACTIVE_JOB_STATUSES } },
      orderBy: { createdAt: "desc" },
    });
    if (inFlight) {
      return ok({ jobId: inFlight.id, status: inFlight.status, progress: inFlight.progress });
    }

    if (project.status === ProjectStatus.COMPLETED) {
      throw Errors.conflict("This project has already been generated. Duplicate it to regenerate.");
    }

    await reserveCredits({
      userId: ctx.userId,
      projectId: project.id,
      duration: project.duration,
      idempotencyReason: `generate:${project.id}`,
    });

    let jobId: string;
    try {
      const job = await db.$transaction(async (tx: Prisma.TransactionClient) => {
        const created = await tx.generationJob.create({
          data: {
            projectId: project.id,
            activeKey: project.id,
            status: JobStatus.QUEUED,
            currentStage: "queued",
            progress: 0,
          },
        });
        await tx.project.update({ where: { id: project.id }, data: { status: ProjectStatus.QUEUED } });
        return created;
      });
      jobId = job.id;
    } catch (err) {
      // P2002 = unique constraint violation on activeKey - another request
      // won the race between our check above and this insert. Recover
      // gracefully by returning that job instead of erroring.
      if (isUniqueConstraintError(err)) {
        const existing = await db.generationJob.findFirst({
          where: { projectId: project.id, status: { in: ACTIVE_JOB_STATUSES } },
          orderBy: { createdAt: "desc" },
        });
        if (existing) return ok({ jobId: existing.id, status: existing.status, progress: existing.progress });
      }
      throw err;
    }

    await getJobQueueAdapter().notify(jobId);

    logger.info({ projectId: project.id, jobId }, "generation_job_enqueued");
    return ok({ jobId, status: JobStatus.QUEUED, progress: 0 }, 202);
  } catch (err) {
    return fail(err);
  }
}
