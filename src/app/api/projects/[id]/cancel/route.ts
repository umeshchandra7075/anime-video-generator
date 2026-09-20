import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/context";
import { getOwnedProject } from "@/lib/domain/projectAccess";
import { getJobQueueAdapter } from "@/lib/queue/jobQueueFactory";
import { refundCredits, creditCostForDuration } from "@/lib/usage/creditService";
import { markCancelled } from "@/lib/pipeline/jobTracking";
import { JobStatus, ACTIVE_JOB_STATUSES } from "@/lib/domain/enums";
import { ok, fail } from "@/lib/api/response";
import { Errors } from "@/lib/api/errors";

interface Params {
  params: { id: string };
}

/**
 * Race-safe against a worker claiming the job at the same moment: the
 * "nothing is running yet" path uses the same atomic conditional-update
 * pattern as the worker's claim (updateMany gated on the status we last
 * observed). If that update affects zero rows, a worker won the race and
 * already flipped the job to PROCESSING - we fall through to the
 * cooperative-cancellation path instead of overwriting its state.
 */
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const ctx = await requireAuth(req);
    const project = await getOwnedProject(params.id, ctx.userId);

    const job = await db.generationJob.findFirst({
      where: { projectId: project.id, status: { in: ACTIVE_JOB_STATUSES } },
      orderBy: { createdAt: "desc" },
    });
    if (!job) throw Errors.conflict("There is no active generation to cancel for this project.");

    if (job.status === JobStatus.QUEUED || job.status === JobStatus.RETRYING) {
      const claim = await db.generationJob.updateMany({
        where: { id: job.id, status: job.status },
        data: { status: JobStatus.CANCELLED, activeKey: null },
      });

      if (claim.count === 1) {
        await db.project.update({ where: { id: project.id }, data: { status: "CANCELLED" } });
        await db.jobEvent.create({ data: { jobId: job.id, stage: "cancelled", message: "Cancelled before a worker picked it up." } });
        await refundCredits({
          userId: ctx.userId,
          amount: creditCostForDuration(project.duration),
          reason: `refund:cancel:${project.id}`,
        });
        return ok({ status: JobStatus.CANCELLED });
      }
      // else: a worker claimed it first (status is no longer QUEUED/RETRYING) - fall through below.
    }

    // Job is actively being processed - request cooperative cancellation.
    // The worker checks this flag between pipeline stages and transitions
    // to CANCELLED (and triggers the refund) itself; we don't refund here
    // to avoid double-refunding a job that's already mid-flight.
    const cooperativeCancel = await db.generationJob.updateMany({
      where: { id: job.id, status: { in: [JobStatus.PROCESSING, JobStatus.QUEUED, JobStatus.RETRYING] } },
      data: { cancelRequested: true, status: JobStatus.CANCEL_REQUESTED },
    });

    if (cooperativeCancel.count === 0) {
      // The job reached a terminal state in the moment between our checks -
      // report what actually happened rather than a cancellation that didn't occur.
      const current = await db.generationJob.findUnique({ where: { id: job.id } });
      return ok({ status: current?.status ?? "UNKNOWN", message: "This job already finished before it could be cancelled." });
    }

    await getJobQueueAdapter().requestCancel(job.id);
    return ok({ status: JobStatus.CANCEL_REQUESTED });
  } catch (err) {
    return fail(err);
  }
}
