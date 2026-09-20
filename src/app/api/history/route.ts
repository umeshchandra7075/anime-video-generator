import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/context";
import { ok, fail } from "@/lib/api/response";

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireAuth(req);
    const { searchParams } = new URL(req.url);
    const page = Math.max(1, Number(searchParams.get("page") ?? "1"));
    const pageSize = Math.min(50, Math.max(1, Number(searchParams.get("pageSize") ?? "20")));

    const where = { project: { userId: ctx.userId } };

    const [items, total] = await Promise.all([
      db.generationJob.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          status: true,
          currentStage: true,
          progress: true,
          errorCode: true,
          errorMessage: true,
          attemptCount: true,
          createdAt: true,
          updatedAt: true,
          project: { select: { id: true, title: true, duration: true, animeStyle: true } },
        },
      }),
      db.generationJob.count({ where }),
    ]);

    return ok({ items, page, pageSize, total });
  } catch (err) {
    return fail(err);
  }
}
