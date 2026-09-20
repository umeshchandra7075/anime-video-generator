import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/context";
import { ProviderFactory } from "@/lib/ai/factory/provider-factory";
import { uploadObject, projectStorageKey } from "@/lib/storage/objectStorage";
import { ok, fail } from "@/lib/api/response";
import { Errors } from "@/lib/api/errors";
import { logger } from "@/lib/logger";

const MAX_RETRIES = 3;

interface Params {
  params: { id: string };
}

/**
 * Retries just the failed scene's image (the cheapest, synchronous stage to
 * redo directly from an API route). Video/voice retries are heavier and
 * asynchronous, so those are re-queued via the generation worker instead -
 * this endpoint still records the retry attempt either way.
 */
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const ctx = await requireAuth(req);

    const scene = await db.scene.findFirst({
      where: { id: params.id, project: { userId: ctx.userId, deletedAt: null } },
      include: { project: true },
    });
    if (!scene) throw Errors.notFound("Scene not found.");

    if (scene.status !== "FAILED") {
      throw Errors.conflict("Only a failed scene can be retried.");
    }
    if (scene.retryCount >= MAX_RETRIES) {
      throw Errors.conflict(`This scene has already been retried ${MAX_RETRIES} times.`);
    }

    await db.scene.update({
      where: { id: scene.id },
      data: { status: "PROCESSING", retryCount: { increment: 1 }, errorMessage: null },
    });

    try {
      const imageProvider = ProviderFactory.getImageProvider();
      const image = await imageProvider.generateImage({
        prompt: scene.imagePrompt ?? "Anime scene illustration.",
        size: "1792x1024",
      });
      const key = projectStorageKey(scene.projectId, "scenes", `${scene.sceneNumber}`, "image.png");
      await uploadObject(key, Buffer.from(image.imageBase64, "base64"), "image/png");

      await db.$transaction([
        db.sceneAsset.create({
          data: {
            sceneId: scene.id,
            type: "IMAGE",
            storageKey: key,
            providerName: image.providerName,
            providerMetadata: JSON.stringify(image.providerMetadata),
            // providerMetadata: image.providerMetadata as object,
          },
        }),
        db.scene.update({ where: { id: scene.id }, data: { status: "COMPLETED" } }),
      ]);

      logger.info({ sceneId: scene.id }, "scene_retry_succeeded");
      return ok({ message: "Scene retried successfully.", sceneId: scene.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Scene retry failed.";
      await db.scene.update({ where: { id: scene.id }, data: { status: "FAILED", errorMessage: message } });
      throw Errors.providerError(message);
    }
  } catch (err) {
    return fail(err);
  }
}
