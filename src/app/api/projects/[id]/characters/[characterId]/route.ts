import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/context";
import { ok, fail } from "@/lib/api/response";
import { Errors } from "@/lib/api/errors";
import { getOwnedProject } from "@/lib/domain/projectAccess";
import { toJson, fromJson } from "@/lib/domain/json";
import type { CharacterVoiceConfig } from "@/lib/domain/characterVoice";

interface Params {
  params: { id: string; characterId: string };
}

// Mirrors CharacterVoiceConfig (src/lib/domain/characterVoice.ts). Only
// voice tuning lives here - never the ElevenLabs API key, which stays
// server-side in ELEVENLABS_API_KEY and is never accepted from a client.
const voiceConfigSchema = z.object({
  voiceId: z.string().min(1).max(128).optional(),
  modelId: z.string().min(1).max(128).optional(),
  stability: z.number().min(0).max(1).optional(),
  similarityBoost: z.number().min(0).max(1).optional(),
  style: z.number().min(0).max(1).optional(),
  speed: z.number().min(0.7).max(1.2).optional(),
});

const updateCharacterSchema = z.object({
  // Passing null clears the override and reverts the character to the
  // ELEVENLABS_DEFAULT_VOICE_ID / ELEVENLABS_MODEL_ID fallback.
  voiceConfig: voiceConfigSchema.nullable(),
});

async function loadOwnedCharacter(projectId: string, characterId: string, userId: string) {
  await getOwnedProject(projectId, userId);
  const character = await db.character.findFirst({ where: { id: characterId, projectId } });
  if (!character) throw Errors.notFound("Character not found.");
  return character;
}

function serialize(character: { id: string; name: string; voiceConfig: string | null }) {
  return {
    id: character.id,
    name: character.name,
    voiceConfig: fromJson<CharacterVoiceConfig | null>(character.voiceConfig, null),
  };
}

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const ctx = await requireAuth(req);
    const character = await loadOwnedCharacter(params.id, params.characterId, ctx.userId);
    return ok(serialize(character));
  } catch (err) {
    return fail(err);
  }
}

/** Sets or clears a character's server-side ElevenLabs voice override. */
export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const ctx = await requireAuth(req);
    const character = await loadOwnedCharacter(params.id, params.characterId, ctx.userId);

    const body = await req.json().catch(() => null);
    const parsed = updateCharacterSchema.safeParse(body);
    if (!parsed.success) throw Errors.validation("Invalid character voice configuration.");

    const updated = await db.character.update({
      where: { id: character.id },
      data: { voiceConfig: toJson(parsed.data.voiceConfig) },
    });

    return ok(serialize(updated));
  } catch (err) {
    return fail(err);
  }
}
