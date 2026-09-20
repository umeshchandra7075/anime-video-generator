import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { fromJson } from "@/lib/domain/json";
import type { SceneTimeline } from "@/lib/engine/types";
import type { RigSpec, Sprite } from "@/lib/engine/puppet";
import { resolveRenderSettings } from "@/lib/engine/render";
import type { RenderSettings } from "@/lib/engine/render";
import { renderProject } from "@/lib/engine/projectRender";
import type { ProjectRenderOptions, ProjectRenderResult, SceneRenderInput } from "@/lib/engine/projectRender";

export interface CompositeSceneInput {
  id: string;
  sceneNumber: number;
  /** JSON-encoded SceneTimeline (Scene.timeline). Required: written by the voice stage. */
  timeline?: string | null;
}

export interface CompositeDeps {
  db: {
    sceneAsset: { findMany(args: { where: Record<string, unknown>; orderBy?: Record<string, string> }): Promise<Array<{ type: string; storageKey: string; providerMetadata: string | null }>> };
    audioAsset: { findFirst(args: { where: Record<string, unknown> }): Promise<{ storageKey: string } | null> };
    character: { findMany(args: { where: Record<string, unknown> }): Promise<Array<{ id: string; providerMetadata: string | null }>> };
  };
  store: { get(key: string): Promise<Buffer>; put(key: string, data: Buffer, mime: string): Promise<void>; key(projectId: string, ...parts: string[]): string };
  render: (o: ProjectRenderOptions) => Promise<ProjectRenderResult>;
  env: NodeJS.ProcessEnv;
  tmpRoot?: string;
  log?: (line: string) => void;
}

export interface CompositeOptions {
  aspectRatio?: "16:9" | "9:16" | "1:1" | string;
  deps?: CompositeDeps;
  onProgress?: (fraction: number, message: string) => void | Promise<void>;
  /** Keep stems for inspection (tests / debugging). */
  keepStemsDir?: string;
}

export interface CompositeResult { storageKey: string; durationSeconds: number; fileSizeBytes: number; settings: RenderSettings; report: ProjectRenderResult["scenes"]; preMasterLufs: number | null }

async function defaultDeps(): Promise<CompositeDeps> {
  const [{ db }, storage, { logger }] = await Promise.all([import("@/lib/db"), import("@/lib/storage/objectStorage"), import("@/lib/logger")]);
  return {
    db: db as unknown as CompositeDeps["db"],
    store: { get: (k) => storage.downloadObject(k), put: async (k, d, m) => { await storage.uploadObject(k, d, m); }, key: (pid, ...p) => storage.projectStorageKey(pid, ...p) },
    render: renderProject, env: process.env, log: (l) => logger.info({ line: l }, "composite_stage"),
  };
}

const EXT_BY_TYPE: Record<string, string> = { LIP_SYNC_CLIP: "mp4", VIDEO_CLIP: "mp4", IMAGE: "png" };

/**
 * Builds the final MP4 from the per-scene MASTER TIMELINES: dialogue/SFX are placed at timeline positions, music is
 * ducked under speech, scenes are normalised to identical stream parameters (so concat is safe whatever produced the
 * clip), the camera plan is applied, and - for characters that have layered rigs - mouths/blinks/expressions are
 * composited from the viseme and actor tracks. The output is fully validated (H.264+AAC, geometry, fps, planned
 * length, clean decode); a file that fails validation makes the job FAIL.
 */
export async function compositeFinalVideo(projectId: string, scenes: CompositeSceneInput[], subtitleLanguage?: string, opts: CompositeOptions = {}): Promise<CompositeResult> {
  const deps = opts.deps ?? (await defaultDeps());
  const workDir = await fs.mkdtemp(path.join(deps.tmpRoot ?? os.tmpdir(), "avg-render-"));
  try {
    const settings = resolveRenderSettings(opts.aspectRatio ?? "16:9", deps.env);
    const rigRows = await deps.db.character.findMany({ where: { projectId } });
    const rigSpecs = new Map<string, RigSpec>();
    for (const c of rigRows) { const rig = fromJson<{ rig?: RigSpec }>(c.providerMetadata, {}).rig; if (rig?.mouth) rigSpecs.set(c.id, { ...rig, characterId: c.id }); }

    const inputs: SceneRenderInput[] = [];
    for (const scene of scenes) {
      const tl = fromJson<SceneTimeline | null>(scene.timeline ?? null, null);
      if (!tl) throw new Error(`Scene ${scene.sceneNumber} has no master timeline - voice generation must run before rendering.`);
      const assets = await deps.db.sceneAsset.findMany({ where: { sceneId: scene.id }, orderBy: { createdAt: "desc" } });
      const pick = assets.find((a) => a.type === "LIP_SYNC_CLIP") ?? assets.find((a) => a.type === "VIDEO_CLIP") ?? assets.find((a) => a.type === "IMAGE");
      if (!pick) throw new Error(`Scene ${scene.sceneNumber} has no video clip or image - cannot composite.`);
      const sourceFile = path.join(workDir, `scene-${scene.sceneNumber}-source.${EXT_BY_TYPE[pick.type] ?? "bin"}`);
      const bytes = await deps.store.get(pick.storageKey);
      if (bytes.length === 0) throw new Error(`Scene ${scene.sceneNumber} source (${pick.type}) is empty - cannot continue rendering.`);
      await fs.writeFile(sourceFile, bytes);

      const dialogueFiles: Record<string, string> = {};
      for (const a of assets.filter((x) => x.type === "DIALOGUE_AUDIO")) {
        const segmentId = fromJson<{ segmentId?: string }>(a.providerMetadata, {}).segmentId;
        if (!segmentId || !tl.segments.some((s) => s.segmentId === segmentId) || dialogueFiles[segmentId]) continue;
        const f = path.join(workDir, `scene-${scene.sceneNumber}-${segmentId}.audio`);
        await fs.writeFile(f, await deps.store.get(a.storageKey));
        dialogueFiles[segmentId] = f;
      }
      for (const s of tl.segments) if (!dialogueFiles[s.segmentId]) throw new Error(`Scene ${scene.sceneNumber}: audio for ${s.segmentId} is missing - regenerate the voice for this scene.`);

      const rigs: RigSpec[] = [];
      for (const actor of tl.actors) {
        const spec = rigSpecs.get(actor.characterId); if (!spec) continue;
        const local = async (sp: Sprite | undefined): Promise<Sprite | undefined> => {
          if (!sp) return undefined;
          const f = path.join(workDir, `rig-${actor.characterId}-${path.basename(sp.file).replace(/[^\w.-]/g, "_")}`);
          await fs.writeFile(f, await deps.store.get(sp.file)); return { ...sp, file: f };
        };
        const sprites: Record<string, string> = {};
        for (const [v, k] of Object.entries(spec.mouth.sprites)) if (k) { const f = path.join(workDir, `rig-${actor.characterId}-mouth-${v}.png`); await fs.writeFile(f, await deps.store.get(k)); sprites[v] = f; }
        const expressions: NonNullable<RigSpec["expressions"]> = {};
        for (const [e, sp] of Object.entries(spec.expressions ?? {})) { const l = await local(sp as Sprite); if (l) (expressions as Record<string, Sprite>)[e] = l; }
        rigs.push({ characterId: actor.characterId, body: await local(spec.body), head: await local(spec.head), eyesClosed: await local(spec.eyesClosed), expressions, mouth: { rect: spec.mouth.rect, sprites } });
      }
      inputs.push({ timeline: tl, source: { kind: pick.type === "IMAGE" ? "image" : "video", file: sourceFile }, dialogueFiles, rigs: rigs.length ? rigs : undefined });
    }

    const musicAsset = await deps.db.audioAsset.findFirst({ where: { projectId, type: "MUSIC" } });
    let music: { file: string; lufs?: number } | null = null;
    if (musicAsset) { const f = path.join(workDir, "music.bin"); await fs.writeFile(f, await deps.store.get(musicAsset.storageKey)); music = { file: f, lufs: deps.env.MUSIC_LUFS ? Number(deps.env.MUSIC_LUFS) : undefined }; }

    const outFile = path.join(workDir, "final.mp4");
    const result = await deps.render({
      scenes: inputs, music, subtitles: !!subtitleLanguage, settings, workDir, outFile, keepStemsDir: opts.keepStemsDir,
      masterLufs: deps.env.MASTER_LUFS ? Number(deps.env.MASTER_LUFS) : -16, denoiseDialogue: deps.env.AUDIO_DENOISE === "true", onProgress: opts.onProgress, log: deps.log,
    });
    // renderProject already threw RenderValidationError if the file failed validation - a job is never COMPLETE on "ffmpeg didn't crash".
    const finalBuffer = await fs.readFile(outFile);
    const key = deps.store.key(projectId, "final-videos", "output.mp4");
    await deps.store.put(key, finalBuffer, "video/mp4");
    return { storageKey: key, durationSeconds: result.durationSeconds, fileSizeBytes: finalBuffer.length, settings, report: result.scenes, preMasterLufs: result.preMasterLufs };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined); // never leave abandoned render files
  }
}
