import { Queue } from "bullmq";
import { getRedis } from "@/lib/queue/connection";

export interface GenerationJobPayload {
  generationJobId: string; // GenerationJob.id in Postgres - source of truth for status
  projectId: string;
}

export const GENERATION_QUEUE_NAME = "video-generation";

let generationQueueSingleton: Queue<GenerationJobPayload> | undefined;

export function getGenerationQueue(): Queue<GenerationJobPayload> {
  if (!generationQueueSingleton) {
    generationQueueSingleton = new Queue<GenerationJobPayload>(GENERATION_QUEUE_NAME, {
      connection: getRedis(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { age: 60 * 60 * 24 * 7 },
        removeOnFail: false,
      },
    });
  }
  return generationQueueSingleton;
}
