import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/context";
import { getOwnedProject } from "@/lib/domain/projectAccess";
import { fail } from "@/lib/api/response";
import { isLocalMusicFallback } from "@/lib/pipeline/musicStatus";
import { didProjectGetLipSync } from "@/lib/pipeline/lipSyncStatus";

export const dynamic = "force-dynamic";

const POLL_INTERVAL_MS = 2000;

interface Params {
  params: { id: string };
}

/**
 * Streams real job status via SSE by polling the database on an interval.
 * This is a legitimate SSE implementation without requiring a separate
 * pub/sub layer - progress always reflects actual GenerationJob rows, never
 * a fabricated counter. Clients without EventSource support should fall
 * back to polling GET /api/projects/[id]/status.
 */
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const ctx = await requireAuth(req);
    const project = await getOwnedProject(params.id, ctx.userId);

    const encoder = new TextEncoder();
    let closed = false;

    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          if (closed) return;
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };

        const tick = async () => {
          if (closed) return;
          const job = await db.generationJob.findFirst({
            where: { projectId: project.id },
            orderBy: { createdAt: "desc" },
          });

          // Only bother checking once music could plausibly exist (stage
          // has reached "music" or later, or the job is done) to avoid an
          // extra query on every 2s tick for the earlier stages.
          const pastVoiceStage = job && job.currentStage && job.currentStage !== "story_analysis";
          const musicFallback = pastVoiceStage ? await isLocalMusicFallback(project.id) : false;
          const lipSynced = pastVoiceStage ? await didProjectGetLipSync(project.id) : false;

          send("status", {
            status: job?.status ?? "PENDING",
            currentStage: job?.currentStage ?? null,
            progress: job?.progress ?? 0,
            errorCode: job?.errorCode ?? null,
            errorMessage: job?.errorMessage ?? null,
            musicFallback,
            lipSynced,
          });

          if (job && (job.status === "COMPLETED" || job.status === "FAILED" || job.status === "CANCELLED")) {
            send("done", { status: job.status });
            closed = true;
            controller.close();
            return;
          }

          setTimeout(tick, POLL_INTERVAL_MS);
        };

        req.signal.addEventListener("abort", () => {
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed
          }
        });

        await tick();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (err) {
    return fail(err);
  }
}
