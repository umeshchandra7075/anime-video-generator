// Renders a whole project from per-scene master timelines: SFX synthesis ->
// per-scene dialogue/SFX stems -> per-scene video (camera, puppet, fades) ->
// one master mix (ducked music, two-pass loudness) -> stream-copy assembly ->
// full validation. Progress is reported from completed work, not timers.
import fs from "node:fs/promises";
import path from "node:path";
import type { SceneTimeline, SfxEvent, SfxType } from "./types";
import type { RigSpec } from "./puppet";
import { renderSceneVideo, assembleFinal } from "./render";
import type { RenderSettings } from "./render";
import { measureDialogueClip, renderSceneStems, renderMaster } from "./mixer";
import type { DialogueClip, SfxClip } from "./mixer";
import { synthSfx } from "./sfx";
import { buildSrt } from "./srt";
import { validateTimeline } from "./timeline";
import { validateFinalMp4 } from "./validate";
import type { FinalValidation } from "./validate";
import { probeMedia } from "./validate";

export interface SceneRenderInput {
  timeline: SceneTimeline;
  source: { kind: "image" | "video"; file: string };
  dialogueFiles: Record<string, string>; // segmentId -> local audio file
  rigs?: RigSpec[];
}
export interface ProjectRenderOptions {
  scenes: SceneRenderInput[];
  music?: { file: string; lufs?: number } | null;
  subtitles?: boolean;
  settings: RenderSettings;
  workDir: string;
  outFile: string;
  masterLufs?: number;
  denoiseDialogue?: boolean;
  keepStemsDir?: string; // keep dialogue/sfx/ducked-music stems for inspection
  onProgress?: (fraction: number, message: string) => void | Promise<void>;
  log?: (line: string) => void;
}
export interface SceneReport { sceneNumber: number; durationSec: number; camera: { shot: string; reason: string }; visemeQuality: string[]; approximatedVisemes: string[]; warnings: string[]; sfx: number; puppeted: boolean }
export interface ProjectRenderResult { outFile: string; durationSeconds: number; validation: FinalValidation; scenes: SceneReport[]; preMasterLufs: number | null; sceneOffsets: number[] }

export class RenderValidationError extends Error {
  constructor(public readonly validation: FinalValidation) {
    super(`Final render failed validation: ${validation.checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`).join("; ")}`);
    this.name = "RenderValidationError";
  }
}

export async function renderProject(o: ProjectRenderOptions): Promise<ProjectRenderResult> {
  const log = o.log ?? (() => undefined);
  const steps = o.scenes.length * 2 + 3; let done = 0;
  const tick = async (msg: string) => { done++; await o.onProgress?.(Math.min(0.99, done / steps), msg); };
  if (o.scenes.length === 0) throw new Error("No scenes to render.");

  for (const s of o.scenes) {
    const errs = validateTimeline(s.timeline);
    if (errs.length) throw new Error(`Scene ${s.timeline.sceneNumber} timeline is inconsistent: ${errs.slice(0, 3).join("; ")}`);
  }
  const sfxDir = path.join(o.workDir, "sfx"), stemDir = path.join(o.workDir, "stems"), vidDir = path.join(o.workDir, "scenes");
  await Promise.all([sfxDir, stemDir, vidDir, ...(o.keepStemsDir ? [o.keepStemsDir] : [])].map((d) => fs.mkdir(d, { recursive: true })));

  // SFX assets: one synthesized file per (type, length); events reference them by position on the timeline.
  const sfxFiles = new Map<string, string>();
  const sfxFileFor = async (e: SfxEvent): Promise<string> => {
    const dur = e.loop ? Math.min(4, Math.max(1, e.duration)) : e.duration;
    const key = `${e.type}_${Math.round(dur * 1000)}`;
    let f = sfxFiles.get(key);
    if (!f) { f = path.join(sfxDir, `${key}.wav`); await synthSfx(e.type as SfxType, dur, f); sfxFiles.set(key, f); }
    return f;
  };

  const sceneVideos: string[] = [], dlgStems: string[] = [], sfxStems: string[] = [], reports: SceneReport[] = [], offsets: number[] = [];
  let offset = 0, prevDip = 0;
  for (const [i, sc] of o.scenes.entries()) {
    const tl = sc.timeline;
    offsets.push(offset); offset += tl.duration;

    // audio stems (dialogue placed at timeline positions, SFX at theirs)
    const dialogue: DialogueClip[] = [];
    for (const seg of tl.segments) {
      const file = sc.dialogueFiles[seg.segmentId];
      if (!file) throw new Error(`Scene ${tl.sceneNumber}: audio file for ${seg.segmentId} is missing.`);
      dialogue.push({ file, start: seg.startTime, loudness: await measureDialogueClip(file, { denoise: !!o.denoiseDialogue }), denoise: !!o.denoiseDialogue });
    }
    const sfx: SfxClip[] = [];
    for (const e of tl.sfx) sfx.push({ file: await sfxFileFor(e), start: e.startTime, duration: e.duration, volume: e.volume, loop: e.loop });
    const dS = path.join(stemDir, `scene-${tl.sceneNumber}-dialogue.wav`), sS = path.join(stemDir, `scene-${tl.sceneNumber}-sfx.wav`);
    log(`[AUDIO] scene ${tl.sceneNumber}: ${dialogue.length} dialogue clip(s), ${sfx.length} sfx event(s)`);
    await renderSceneStems({ duration: tl.duration, dialogue, sfx }, { dialogue: dS, sfx: sS });
    dlgStems.push(dS); sfxStems.push(sS);
    await tick(`Scene ${tl.sceneNumber}: audio mixed`);

    // video
    const out = path.join(vidDir, `scene-${tl.sceneNumber}.mp4`);
    log(`[CAMERA] scene ${tl.sceneNumber}: ${tl.camera.shot} (${tl.camera.reason}), ${tl.camera.moves.length} move(s)`);
    const r = await renderSceneVideo({ source: sc.source, timeline: tl, settings: o.settings, out, workDir: o.workDir, rigs: sc.rigs, fadeInSec: prevDip });
    prevDip = tl.transition.type === "dip" ? tl.transition.duration / 2 : 0;
    sceneVideos.push(out);
    reports.push({ sceneNumber: tl.sceneNumber, durationSec: tl.duration, camera: { shot: tl.camera.shot, reason: tl.camera.reason }, visemeQuality: [...new Set(tl.visemes.map((v) => v.quality))], approximatedVisemes: r.approximatedVisemes, warnings: tl.warnings, sfx: tl.sfx.length, puppeted: !!(sc.rigs && sc.rigs.length) });
    await tick(`Scene ${tl.sceneNumber}: video rendered`);
  }

  const master = path.join(o.workDir, "master.wav");
  const total = offset;
  const { measuredPreMasterLufs } = await renderMaster({
    dialogueStems: dlgStems, sfxStems, totalDuration: total, masterLufs: o.masterLufs ?? -16,
    music: o.music ? { file: o.music.file, lufs: o.music.lufs } : null,
    debugDuckedMusic: o.keepStemsDir && o.music ? path.join(o.keepStemsDir, "music-ducked.wav") : undefined,
  }, master);
  await tick("Master mix complete");

  let srt: string | null = null;
  if (o.subtitles) { srt = path.join(o.workDir, "subs.srt"); await fs.writeFile(srt, buildSrt(o.scenes.map((s) => s.timeline)), "utf8"); }
  await assembleFinal({ sceneVideos, audio: master, subtitles: srt, settings: o.settings, out: o.outFile, workDir: o.workDir });
  await tick("Assembled");

  const validation = await validateFinalMp4(o.outFile, { width: o.settings.width, height: o.settings.height, fps: o.settings.fps, durationSec: total, durationToleranceSec: 0.25 });
  if (o.keepStemsDir) {
    await fs.copyFile(master, path.join(o.keepStemsDir, "master.wav"));
    for (const [i, s] of dlgStems.entries()) await fs.copyFile(s, path.join(o.keepStemsDir, path.basename(s)));
    for (const s of sfxStems) await fs.copyFile(s, path.join(o.keepStemsDir, path.basename(s)));
  }
  if (!validation.ok) throw new RenderValidationError(validation);
  const info = await probeMedia(o.outFile);
  await o.onProgress?.(1, "Render validated");
  return { outFile: o.outFile, durationSeconds: info.formatDuration, validation, scenes: reports, preMasterLufs: measuredPreMasterLufs, sceneOffsets: offsets };
}
