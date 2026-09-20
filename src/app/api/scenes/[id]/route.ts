import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/context";
import { ok, fail } from "@/lib/api/response";
import { Errors } from "@/lib/api/errors";
import type { Prisma } from "@prisma/client";

interface Params {
  params: { id: string };
}

const updateSceneSchema = z.object({
  description: z.string().max(2000).optional(),
  imagePrompt: z.string().max(2000).optional(),
  animationPrompt: z.string().max(2000).optional(),
  animationNegativePrompt: z.string().max(2000).optional(),
  narration: z.string().max(2000).optional(),
  orderIndex: z.number().int().min(0).optional(),
});

async function loadOwnedScene(sceneId: string, userId: string) {
  const scene = await db.scene.findFirst({
    where: { id: sceneId, project: { userId, deletedAt: null } },
  });
  if (!scene) throw Errors.notFound("Scene not found.");
  return scene;
}

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const ctx = await requireAuth(req);
    const scene = await loadOwnedScene(params.id, ctx.userId);

    const body = await req.json().catch(() => null);
    const parsed = updateSceneSchema.safeParse(body);
    if (!parsed.success) throw Errors.validation("Invalid scene update.");

    const updated = await db.scene.update({ where: { id: scene.id }, data: parsed.data });
    return ok(updated);
  } catch (err) {
    return fail(err);
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    const ctx = await requireAuth(req);
    const scene = await loadOwnedScene(params.id, ctx.userId);

    await db.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.scene.delete({ where: { id: scene.id } });
      // Close the gap left in orderIndex so downstream compositing stays contiguous.
      await tx.scene.updateMany({
        where: { projectId: scene.projectId, orderIndex: { gt: scene.orderIndex } },
        data: { orderIndex: { decrement: 1 } },
      });
    });

    return ok({ message: "Scene deleted." });
  } catch (err) {
    return fail(err);
  }
}
