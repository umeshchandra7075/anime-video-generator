import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/context";
import { getOwnedProject } from "@/lib/domain/projectAccess";
import { ok, fail } from "@/lib/api/response";

interface Params {
  params: { id: string };
}

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const ctx = await requireAuth(req);
    const project = await getOwnedProject(params.id, ctx.userId);

    const scenes = await db.scene.findMany({
      where: { projectId: project.id },
      orderBy: { orderIndex: "asc" },
      include: { assets: true },
    });

    return ok(scenes);
  } catch (err) {
    return fail(err);
  }
}
