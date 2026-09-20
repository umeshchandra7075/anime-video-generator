import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/context";
import { getOwnedProject } from "@/lib/domain/projectAccess";
import { updateProjectSchema } from "@/lib/validation/schemas";
import { ok, fail } from "@/lib/api/response";
import { Errors } from "@/lib/api/errors";

interface Params {
  params: { id: string };
}

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const ctx = await requireAuth(req);
    const project = await db.project.findFirst({
      where: { id: params.id, userId: ctx.userId, deletedAt: null },
      include: {
        characters: true,
        scenes: { orderBy: { orderIndex: "asc" } },
        videoAssets: true,
        subtitles: true,
      },
    });
    if (!project) throw Errors.notFound("Project not found.");
    return ok(project);
  } catch (err) {
    return fail(err);
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const ctx = await requireAuth(req);
    const project = await getOwnedProject(params.id, ctx.userId);

    if (project.status === "PROCESSING") {
      throw Errors.conflict("Cannot edit a project while it is generating.");
    }

    const body = await req.json().catch(() => null);
    const parsed = updateProjectSchema.safeParse(body);
    if (!parsed.success) throw Errors.validation("Invalid update payload.");

    const updated = await db.project.update({
      where: { id: project.id },
      data: parsed.data,
    });

    return ok(updated);
  } catch (err) {
    return fail(err);
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    const ctx = await requireAuth(req);
    const project = await getOwnedProject(params.id, ctx.userId);

    // Soft-delete: assets remain in object storage/DB for audit/recovery
    // purposes but the project disappears from the user's view immediately.
    await db.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });

    return ok({ message: "Project deleted." });
  } catch (err) {
    return fail(err);
  }
}
