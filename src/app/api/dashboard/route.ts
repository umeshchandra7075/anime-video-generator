import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/context";
import { ok, fail } from "@/lib/api/response";

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireAuth(req);

    const [total, completed, processing, failed, user, recent] = await Promise.all([
      db.project.count({ where: { userId: ctx.userId, deletedAt: null } }),
      db.project.count({ where: { userId: ctx.userId, deletedAt: null, status: "COMPLETED" } }),
      db.project.count({
        where: { userId: ctx.userId, deletedAt: null, status: { in: ["QUEUED", "PROCESSING"] } },
      }),
      db.project.count({ where: { userId: ctx.userId, deletedAt: null, status: "FAILED" } }),
      db.user.findUnique({ where: { id: ctx.userId }, select: { credits: true } }),
      db.project.findMany({
        where: { userId: ctx.userId, deletedAt: null },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true,
          title: true,
          language: true,
          animeStyle: true,
          duration: true,
          status: true,
          createdAt: true,
        },
      }),
    ]);

    return ok({
      totals: { total, completed, processing, failed, remainingCredits: user?.credits ?? 0 },
      recentVideos: recent,
    });
  } catch (err) {
    return fail(err);
  }
}
