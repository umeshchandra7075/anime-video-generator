import { JobQueueAdapter } from "@/lib/queue/jobQueueAdapter";

export class BullMqQueueAdapter implements JobQueueAdapter {
  readonly name = "bullmq" as const;

  async notify(generationJobId: string): Promise<void> {
    // Dynamically imported so bullmq/ioredis are never touched unless this
    // driver is explicitly selected - keeps local dev fully Redis-free.
    const { getGenerationQueue } = await import("@/lib/queue/queues");
    const { db } = await import("@/lib/db");

    const job = await db.generationJob.findUnique({ where: { id: generationJobId } });
    if (!job) return;

    const queue = getGenerationQueue();
    await queue.add(
      "generate-video",
      { generationJobId, projectId: job.projectId },
      { jobId: generationJobId, attempts: 1 }, // retries are modeled in our own DB state machine, not BullMQ's
    );
  }

  async requestCancel(_generationJobId: string): Promise<void> {
    // No BullMQ-side action needed: the worker checks
    // GenerationJob.cancelRequested (the real source of truth) between
    // pipeline stages regardless of dispatch mechanism.
  }
}
