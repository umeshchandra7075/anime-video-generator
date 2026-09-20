import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/context";
import { ok, fail } from "@/lib/api/response";

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req); // throws FORBIDDEN for non-admins - enforced server-side, not just hidden in the UI

    const { searchParams } = new URL(req.url);
    const page = Math.max(1, Number(searchParams.get("page") ?? "1"));
    const pageSize = Math.min(100, Math.max(1, Number(searchParams.get("pageSize") ?? "25")));

    const [items, total] = await Promise.all([
      db.user.findMany({
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          credits: true,
          emailVerifiedAt: true,
          lockedUntil: true,
          createdAt: true,
          _count: { select: { projects: true } },
        },
      }),
      db.user.count(),
    ]);

    return ok({ items, page, pageSize, total });
  } catch (err) {
    return fail(err);
  }
}
