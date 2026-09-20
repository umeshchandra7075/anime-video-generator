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
      throw Errors.conflict("This video is not ready yet.");
    }

    const asset = await db.videoAsset.findFirst({
      where: { projectId: project.id },
      orderBy: { createdAt: "desc" },
    });
    if (!asset) throw Errors.notFound("No finished video found for this project.");

    // Short-lived signed URL - never a permanent public link, and scoped
    // only to the requesting user's own project.
    const url = await getSignedDownloadUrl(asset.storageKey, 900);

    return ok({
      url,
      expiresInSeconds: 900,
      durationSeconds: asset.durationSecs,
      resolution: asset.resolution,
      format: asset.format,
    });
  } catch (err) {
    return fail(err);
  }
}
