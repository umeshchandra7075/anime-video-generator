import { JobQueueAdapter } from "@/lib/queue/jobQueueAdapter";
import { DbPollingQueueAdapter } from "@/lib/queue/dbPollingQueue";

let adapterSingleton: JobQueueAdapter | undefined;

function createAdapter(): JobQueueAdapter {
  if (process.env.JOB_QUEUE_DRIVER === "redis") {
    // Imported lazily so a dev environment without bullmq/ioredis
    // configured never pays this cost.
    const mod = require("@/lib/queue/bullmqQueue") as typeof import("@/lib/queue/bullmqQueue");
    return new mod.BullMqQueueAdapter();
  }
  return new DbPollingQueueAdapter();
}

export function getJobQueueAdapter(): JobQueueAdapter {
  if (!adapterSingleton) {
    adapterSingleton = createAdapter();
  }
  return adapterSingleton;
}
