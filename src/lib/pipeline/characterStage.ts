import { db } from "@/lib/db";
import { ProviderFactory } from "@/lib/ai/factory/provider-factory";
import { uploadObject, projectStorageKey } from "@/lib/storage/objectStorage";
import { toJson } from "@/lib/domain/json";
import type { StructuredStory } from "@/lib/ai/interfaces/text-provider";

/** Idempotent: reuses already-generated characters on retry instead of
 * regenerating (and re-billing provider calls for) images that already exist. */
export async function createCharacters(
  projectId: string,
  animeStyle: string,
  structured: StructuredStory,
) {
  const existing = await db.character.findMany({ where: { projectId } });
  if (existing.length > 0) return existing;

  const imageProvider = ProviderFactory.getImageProvider();
  const created = [];

  for (const c of structured.characters) {
    const prompt = buildCharacterPrompt(animeStyle, c);
    const image = await imageProvider.generateImage({ prompt, size: "1024x1024" });

    const key = projectStorageKey(projectId, "characters", `${slugify(c.name)}.png`);
    await uploadObject(key, Buffer.from(image.imageBase64, "base64"), "image/png");

    const character = await db.character.create({
      data: {
        projectId,
        name: c.name,
        ageRange: c.ageRange,
        gender: c.gender,
        appearance: c.appearance,
        hair: c.hair,
        eyes: c.eyes,
        clothes: c.clothes,
        accessories: c.accessories,
        personality: c.personality,
        styleDescription: c.styleDescription,
        referenceImageUrl: key,
        providerMetadata: toJson(image.providerMetadata),
      },
    });
    created.push(character);
  }

  return created;
}

function buildCharacterPrompt(
  animeStyle: string,
  c: StructuredStory["characters"][number],
): string {
  return [
    `${animeStyle} character reference sheet, full body, neutral pose, clean background.`,
    `Name: ${c.name}.`,
    c.ageRange ? `Age range: ${c.ageRange}.` : "",
    c.gender ? `Gender: ${c.gender}.` : "",
    c.appearance ? `Appearance: ${c.appearance}.` : "",
    c.hair ? `Hair: ${c.hair}.` : "",
    c.eyes ? `Eyes: ${c.eyes}.` : "",
    c.clothes ? `Clothes: ${c.clothes}.` : "",
    c.accessories ? `Accessories: ${c.accessories}.` : "",
    c.styleDescription ? `Style notes: ${c.styleDescription}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "character";
}
