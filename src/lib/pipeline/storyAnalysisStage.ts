import { db } from "@/lib/db";
import { ProviderFactory } from "@/lib/ai/factory/provider-factory";
import { durationToSeconds } from "@/lib/domain/duration";
import { toJson, fromJson } from "@/lib/domain/json";
import type { StructuredStory } from "@/lib/ai/interfaces/text-provider";

export interface StoryAnalysisProjectInput {
  id: string;
  title: string;
  story: string;
  language: string;
  animeStyle: string;
  duration: string;
  structuredStory?: string | null;
}

/** Idempotent: if this project was already analyzed (e.g. on a retry after a
 * later stage failed), the cached result is reused instead of calling the
 * text provider again. */
export async function runStoryAnalysis(project: StoryAnalysisProjectInput): Promise<StructuredStory> {
  const cached = fromJson<StructuredStory | null>(project.structuredStory, null);
  if (cached && Array.isArray(cached.scenes) && cached.scenes.length > 0) {
    return cached;
  }

  const textProvider = ProviderFactory.getTextProvider();

  const structured = await textProvider.analyzeStory({
    story: project.story,
    language: project.language,
    animeStyle: project.animeStyle,
    targetDurationSeconds: durationToSeconds(project.duration),
  });

  await db.project.update({
    where: { id: project.id },
    data: { structuredStory: toJson(structured), title: structured.title || project.title },
  });

  return structured;
}
