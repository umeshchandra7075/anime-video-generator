/**
 * The GenerationJob table (see prisma/schema.prisma) is always the durable
 * source of truth for job state, progress, cancellation, and recovery -
 * that's what makes jobs survive a worker restart or browser refresh. This
 * adapter is only an optional, best-effort "wake up and check now" signal
 * so a worker isn't stuck waiting out a full poll interval; it is never
 * required for correctness, only latency.
 *
 * Local development uses DbPollingQueueAdapter (notify()/requestCancel() are
 * no-ops - the worker's poll loop and the DB's cancelRequested flag already
 * handle everything). Production can opt into BullMqQueueAdapter for lower
 * latency across multiple worker processes by setting JOB_QUEUE_DRIVER=redis.
 */
export interface JobQueueAdapter {
  readonly name: "db-polling" | "bullmq";
  notify(generationJobId: string): Promise<void>;
  requestCancel(generationJobId: string): Promise<void>;
}
