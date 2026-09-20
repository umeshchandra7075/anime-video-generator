import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/context";
import { createProjectSchema } from "@/lib/validation/schemas";
import { ok, fail } from "@/lib/api/response";
import { Errors } from "@/lib/api/errors";

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireAuth(req);
    const { searchParams } = new URL(req.url);
    const page = Math.max(1, Number(searchParams.get("page") ?? "1"));
    const pageSize = Math.min(50, Math.max(1, Number(searchParams.get("pageSize") ?? "20")));

    const [items, total] = await Promise.all([
      db.project.findMany({
        where: { userId: ctx.userId, deletedAt: null },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
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
      db.project.count({ where: { userId: ctx.userId, deletedAt: null } }),
    ]);

    return ok({ items, page, pageSize, total });
  } catch (err) {
    return fail(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireAuth(req);
    if (!ctx.emailVerified) throw Errors.emailNotVerified();

    const body = await req.json().catch(() => null);
    const parsed = createProjectSchema.safeParse(body);
    if (!parsed.success) {
      throw Errors.validation(parsed.error.errors[0]?.message ?? "Invalid project settings.");
    }
    const data = parsed.data;

    const project = await db.project.create({
      data: {
        userId: ctx.userId,
        title: deriveWorkingTitle(data.story),
        story: data.story,
        language: data.language,
        animeStyle: data.animeStyle,
        duration: data.duration,
        aspectRatio: data.aspectRatio,
        voiceGender: data.voiceGender,
        voiceStyle: data.voiceStyle,
        subtitlesOn: data.subtitlesOn,
        subtitleLang: data.subtitleLang,
        musicMood: data.musicMood,
        status: "DRAFT",
      },
    });

    return ok(project, 201);
  } catch (err) {
    return fail(err);
  }
}

function deriveWorkingTitle(story: string): string {
  const firstSentence = story.trim().split(/[.!?\n]/)[0] ?? story;
  return firstSentence.length > 60 ? `${firstSentence.slice(0, 57)}...` : firstSentence || "Untitled Project";
}
