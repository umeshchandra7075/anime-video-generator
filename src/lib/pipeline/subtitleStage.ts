import { fromJson } from "@/lib/domain/json";
import { buildSrt, srtTime } from "@/lib/engine/srt";
import type { SceneTimeline } from "@/lib/engine/types";

export interface SubtitleSceneInput {
  sceneNumber: number;
  narration: string | null;
  dialogue: string | null; // JSON-encoded {character,line}[]
  estimatedSeconds: number | null;
  /** JSON-encoded SceneTimeline (Scene.timeline). When every scene has one, cues use the MEASURED audio windows. */
  timeline?: string | null;
}

export interface SubtitleStageDeps {
  db: {
    subtitle: { deleteMany(args: { where: Record<string, unknown> }): Promise<unknown>; create(args: { data: Record<string, unknown> }): Promise<unknown> };
  };
  store: { put(key: string, data: Buffer, mime: string): Promise<void>; key(projectId: string, ...parts: string[]): string };
}

async function defaultDeps(): Promise<SubtitleStageDeps> {
  const [{ db }, storage] = await Promise.all([import("@/lib/db"), import("@/lib/storage/objectStorage")]);
  return { db: db as unknown as SubtitleStageDeps["db"], store: { put: async (k, d, m) => { await storage.uploadObject(k, d, m); }, key: (pid, ...p) => storage.projectStorageKey(pid, ...p) } };
}

/**
 * Builds the subtitle file. With master timelines (the normal case) every cue is placed on the exact measured
 * start/end of its dialogue segment - the same numbers the audio, lip-sync and render use. Only projects without
 * timelines fall back to spreading lines evenly over each scene's ESTIMATED duration.
 * Regeneration replaces the stored file (a stale subtitle for edited dialogue is worse than none).
 */
export async function generateSubtitles(projectId: string, language: string, scenes: SubtitleSceneInput[], deps?: SubtitleStageDeps) {
  const d = deps ?? (await defaultDeps());
  const timelines = scenes.map((s) => fromJson<SceneTimeline | null>(s.timeline ?? null, null));
  const srtContent = timelines.every((t) => t !== null) && scenes.length > 0 ? buildSrt(timelines as SceneTimeline[]) : estimatedSrt(scenes);
  const key = d.store.key(projectId, "subtitles", `${language}.srt`);
  await d.store.put(key, Buffer.from(srtContent, "utf-8"), "application/x-subrip");
  await d.db.subtitle.deleteMany({ where: { projectId, language } });
  await d.db.subtitle.create({ data: { projectId, language, storageKey: key, format: "srt" } });
}

function estimatedSrt(scenes: SubtitleSceneInput[]): string {
  let cursor = 0, index = 1;
  const cues: string[] = [];
  for (const scene of scenes) {
    const duration = scene.estimatedSeconds ?? 5;
    const dialogue = fromJson<{ character: string; line: string }[]>(scene.dialogue, []);
    const lines: string[] = [];
    if (scene.narration) lines.push(scene.narration);
    for (const x of dialogue) if (x?.line) lines.push(`${x.character}: ${x.line}`);
    if (lines.length > 0) {
      const per = duration / lines.length;
      lines.forEach((line, i) => { cues.push(`${index++}\n${srtTime(cursor + i * per)} --> ${srtTime(cursor + (i + 1) * per)}\n${line}\n`); });
    }
    cursor += duration;
  }
  return cues.join("\n");
}
