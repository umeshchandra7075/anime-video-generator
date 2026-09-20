import { db } from "@/lib/db";
import { ProviderFactory } from "@/lib/ai/factory/provider-factory";
import { uploadObject, projectStorageKey } from "@/lib/storage/objectStorage";
import { toJson } from "@/lib/domain/json";
import { SceneStatus } from "@/lib/domain/enums";
import type { StructuredStory } from "@/lib/ai/interfaces/text-provider";

// Narrow shape instead of the full Prisma `Character` model.
export interface SceneCharacterInput {
  id: string;
  name: string;
}

/** Idempotent: reuses already-created scenes on retry rather than duplicating them. */
export async function createScenes(
  projectId: string,
  structured: StructuredStory,
  characters: SceneCharacterInput[],
) {
  const existing = await db.scene.findMany({ where: { projectId }, orderBy: { orderIndex: "asc" } });
  if (existing.length > 0) return existing;

  const byName = new Map(characters.map((c) => [c.name.toLowerCase(), c]));

  const scenes = [];
  for (const [index, s] of structured.scenes.entries()) {
    const characterIds = s.characters
      .map((name) => byName.get(name.toLowerCase())?.id)
      .filter((id): id is string => Boolean(id));

    const scene = await db.scene.create({
      data: {
        projectId,
        sceneNumber: s.sceneNumber ?? index + 1,
        orderIndex: index,
        description: s.description,
        location: s.location,
        timeOfDay: s.timeOfDay,
        characterIds: toJson(characterIds),
        cameraAngle: s.cameraAngle,
        cameraMovement: s.cameraMovement,
        lighting: s.lighting,
        mood: s.mood,
        dialogue: toJson(s.dialogue ?? []),
        narration: s.narration,
        soundEffects: toJson(s.soundEffects ?? []),
        musicMood: s.musicMood,
        imagePrompt: s.imagePrompt,
        animationPrompt: s.animationPrompt,
        animationNegativePrompt: s.animationNegativePrompt,
        estimatedSeconds: s.estimatedDurationSeconds,
        status: SceneStatus.PENDING,
      },
    });
    scenes.push(scene);
  }
  return scenes;
}

/** Generates one still image per scene. Idempotent: scenes that already
 * completed their image (from a prior attempt) are skipped. */
export async function generateSceneImages(
  projectId: string,
  scenes: { id: string; imagePrompt: string | null; sceneNumber: number }[],
) {
  const imageProvider = ProviderFactory.getImageProvider();

  for (const scene of scenes) {
    const existingImage = await db.sceneAsset.findFirst({ where: { sceneId: scene.id, type: "IMAGE" } });
    if (existingImage) continue;

    await db.scene.update({ where: { id: scene.id }, data: { status: SceneStatus.PROCESSING } });
    try {
      const image = await imageProvider.generateImage({
        prompt: scene.imagePrompt ?? "Anime scene illustration.",
        size: "1792x1024",
      });
      const key = projectStorageKey(projectId, "scenes", `${scene.sceneNumber}`, "image.png");
      await uploadObject(key, Buffer.from(image.imageBase64, "base64"), "image/png");

      await db.$transaction([
        db.sceneAsset.create({
          data: {
            sceneId: scene.id,
            type: "IMAGE",
            storageKey: key,
            providerName: image.providerName,
            providerMetadata: toJson(image.providerMetadata),
          },
        }),
        db.scene.update({ where: { id: scene.id }, data: { status: SceneStatus.COMPLETED } }),
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Scene image generation failed.";
      await db.scene.update({
        where: { id: scene.id },
        data: { status: SceneStatus.FAILED, errorMessage: message },
      });
      throw err;
    }
  }
}
