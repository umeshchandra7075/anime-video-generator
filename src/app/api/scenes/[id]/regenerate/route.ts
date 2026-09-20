import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/context";
import { ProviderFactory } from "@/lib/ai/factory/provider-factory";
import { uploadObject, deleteObject, projectStorageKey } from "@/lib/storage/objectStorage";
import { ok, fail } from "@/lib/api/response";
import { Errors } from "@/lib/api/errors";

interface Params {
  params: { id: string };
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const ctx = await requireAuth(req);

    const scene = await db.scene.findFirst({
      where: { id: params.id, project: { userId: ctx.userId, deletedAt: null } },
    });
    if (!scene) throw Errors.notFound("Scene not found.");

    const body = await req.json().catch(() => ({}));
    const promptOverride: string | undefined =
      typeof body?.prompt === "string" && body.prompt.trim() ? body.prompt.trim() : undefined;

    await db.scene.update({ where: { id: scene.id }, data: { status: "PROCESSING", errorMessage: null } });

    try {
      const imageProvider = ProviderFactory.getImageProvider();
      const image = await imageProvider.generateImage({
        prompt: promptOverride ?? scene.imagePrompt ?? "Anime scene illustration.",
        size: "1792x1024",
      });

      const previous = await db.sceneAsset.findFirst({
        where: { sceneId: scene.id, type: "IMAGE" },
        orderBy: { createdAt: "desc" },
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
        db.scene.update({
          where: { id: scene.id },
          data: {
            status: "COMPLETED",
            imagePrompt: promptOverride ?? scene.imagePrompt,
          },
        }),
      ]);

      if (previous && previous.storageKey !== key) {
        await deleteObject(previous.storageKey).catch(() => {});
      }

      return ok({ message: "Scene regenerated.", sceneId: scene.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Scene regeneration failed.";
      await db.scene.update({ where: { id: scene.id }, data: { status: "FAILED", errorMessage: message } });
      throw Errors.providerError(message);
    }
  } catch (err) {
    return fail(err);
  }
}
