import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/context";
import { getSignedDownloadUrl } from "@/lib/storage/objectStorage";
import { ok, fail } from "@/lib/api/response";

interface AssetEntry {
  type: "video" | "character_image";
  projectId: string;
  projectTitle: string;
  name: string;
  url: string;
  createdAt: Date;
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireAuth(req);
    const { searchParams } = new URL(req.url);
    const page = Math.max(1, Number(searchParams.get("page") ?? "1"));
    const pageSize = Math.min(50, Math.max(1, Number(searchParams.get("pageSize") ?? "24")));

    const [videoAssets, characters] = await Promise.all([
      db.videoAsset.findMany({
        where: { project: { userId: ctx.userId, deletedAt: null } },
        orderBy: { createdAt: "desc" },
        include: { project: { select: { id: true, title: true } } },
      }),
      db.character.findMany({
        where: { project: { userId: ctx.userId, deletedAt: null }, referenceImageUrl: { not: null } },
        orderBy: { createdAt: "desc" },
        include: { project: { select: { id: true, title: true } } },
      }),
    ]);

    const entries: AssetEntry[] = [];

    for (const v of videoAssets) {
      entries.push({
        type: "video",
        projectId: v.project.id,
        projectTitle: v.project.title,
        name: `${v.project.title} - final video`,
        url: await getSignedDownloadUrl(v.storageKey, 900),
        createdAt: v.createdAt,
      });
    }
    for (const c of characters) {
      if (!c.referenceImageUrl) continue;
      entries.push({
        type: "character_image",
        projectId: c.project.id,
        projectTitle: c.project.title,
        name: c.name,
        url: await getSignedDownloadUrl(c.referenceImageUrl, 900),
        createdAt: c.createdAt,
      });
    }

    entries.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const total = entries.length;
    const pageItems = entries.slice((page - 1) * pageSize, page * pageSize);

    return ok({ items: pageItems, page, pageSize, total });
  } catch (err) {
    return fail(err);
  }
}
