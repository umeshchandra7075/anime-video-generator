import { JobQueueAdapter } from "@/lib/queue/jobQueueAdapter";

export class DbPollingQueueAdapter implements JobQueueAdapter {
  readonly name = "db-polling" as const;

  // No-ops by design: the worker's poll loop picks up new/available rows on
  // its own interval, and cancellation is communicated via the
  // GenerationJob.cancelRequested column, which the worker checks between
  // pipeline stages regardless of how the job was dispatched.
  async notify(_generationJobId: string): Promise<void> {}
  async requestCancel(_generationJobId: string): Promise<void> {}
}
