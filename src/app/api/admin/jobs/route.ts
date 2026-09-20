import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/context";
import { ok, fail } from "@/lib/api/response";
import type { JobStatusValue } from "@/lib/domain/enums";

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);

    const { searchParams } = new URL(req.url);
    const statusFilter = searchParams.get("status") ?? undefined;
    const page = Math.max(1, Number(searchParams.get("page") ?? "1"));
    const pageSize = Math.min(100, Math.max(1, Number(searchParams.get("pageSize") ?? "25")));

    const where = statusFilter ? { status: statusFilter as JobStatusValue } : {};

    const [items, total, failedCount, providerErrorBreakdown] = await Promise.all([
      db.generationJob.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { project: { select: { id: true, title: true, userId: true } } },
      }),
      db.generationJob.count({ where }),
      db.generationJob.count({ where: { status: "FAILED" } }),
      db.generationJob.groupBy({
        by: ["errorCode"],
        where: { status: "FAILED" },
        _count: { errorCode: true },
      }),
    ]);

    return ok({ items, page, pageSize, total, failedCount, providerErrorBreakdown });
  } catch (err) {
    return fail(err);
  }
}
