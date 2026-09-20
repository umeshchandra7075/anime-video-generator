import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/context";
import { getOwnedProject } from "@/lib/domain/projectAccess";
import { ok, fail } from "@/lib/api/response";
import { isLocalMusicFallback } from "@/lib/pipeline/musicStatus";
import { didProjectGetLipSync } from "@/lib/pipeline/lipSyncStatus";

interface Params {
  params: { id: string };
}

// Clients should prefer the SSE stream at /api/projects/[id]/status/stream
// (see route.ts in the stream subfolder) and fall back to polling this
// endpoint if EventSource isn't available/allowed.
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const ctx = await requireAuth(req);
    const project = await getOwnedProject(params.id, ctx.userId);

    const job = await db.generationJob.findFirst({
      where: { projectId: project.id },
      orderBy: { createdAt: "desc" },
      include: { events: { orderBy: { createdAt: "asc" }, take: 50 } },
    });

    const musicFallback = await isLocalMusicFallback(project.id);
    const lipSynced = await didProjectGetLipSync(project.id);

    return ok({
      projectStatus: project.status,
      job: job
        ? {
            id: job.id,
            status: job.status,
            currentStage: job.currentStage,
            progress: job.progress,
            errorCode: job.errorCode,
            errorMessage: job.errorMessage,
            events: job.events,
            musicFallback,
            lipSynced,
          }
        : null,
    });
  } catch (err) {
    return fail(err);
  }
}
