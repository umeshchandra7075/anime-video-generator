import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/context";
import { getOwnedProject } from "@/lib/domain/projectAccess";
import { ok, fail } from "@/lib/api/response";

interface Params {
  params: { id: string };
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const ctx = await requireAuth(req);
    const project = await getOwnedProject(params.id, ctx.userId);

    const copy = await db.project.create({
      data: {
        userId: ctx.userId,
        title: `${project.title} (copy)`,
        story: project.story,
        language: project.language,
        animeStyle: project.animeStyle,
        duration: project.duration,
        aspectRatio: project.aspectRatio,
        voiceGender: project.voiceGender,
        voiceStyle: project.voiceStyle,
        subtitlesOn: project.subtitlesOn,
        subtitleLang: project.subtitleLang,
        musicMood: project.musicMood,
        status: "DRAFT",
      },
    });

    return ok(copy, 201);
  } catch (err) {
    return fail(err);
  }
}
