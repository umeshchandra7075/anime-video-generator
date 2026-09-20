import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/context";
import { getOwnedProject } from "@/lib/domain/projectAccess";
import { getSignedDownloadUrl } from "@/lib/storage/objectStorage";
import { ok, fail } from "@/lib/api/response";
import { Errors } from "@/lib/api/errors";

interface Params {
  params: { id: string };
}

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const ctx = await requireAuth(req);
    const project = await getOwnedProject(params.id, ctx.userId);

    if (project.status !== "COMPLETED") {
      throw Errors.conflict("This video is not ready to download yet.");
    }

    const [video, subtitles] = await Promise.all([
      db.videoAsset.findFirst({ where: { projectId: project.id }, orderBy: { createdAt: "desc" } }),
      db.subtitle.findMany({ where: { projectId: project.id } }),
    ]);
    if (!video) throw Errors.notFound("No finished video found for this project.");

    const videoUrl = await getSignedDownloadUrl(video.storageKey, 900);
    const subtitleUrls = await Promise.all(
      subtitles.map(async (s: { language: string; format: string; storageKey: string }) => ({
        language: s.language,
        format: s.format,
        url: await getSignedDownloadUrl(s.storageKey, 900),
      })),
    );

    return ok({ video: { url: videoUrl, format: video.format }, subtitles: subtitleUrls });
  } catch (err) {
    return fail(err);
  }
}
