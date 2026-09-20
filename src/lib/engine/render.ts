// Video composition. EVERY scene goes through the same normalisation
// (scale/crop -> fps -> [puppet] -> camera -> fades -> H.264 yuv420p at the
// project's resolution/fps), whichever provider made the source clip. That is
// what makes the final `-c copy` concat safe: all scene files share identical
// stream parameters.
import fs from "node:fs/promises";
import path from "node:path";
import { getBinaries, runProcess } from "./binaries";
import type { SceneTimeline } from "./types";
import { buildCameraFilter } from "./camera";
import { buildPuppetGraph } from "./puppet";
import type { RigSpec } from "./puppet";

export interface RenderSettings { width: number; height: number; fps: number; crf: number; videoBitrateK: number | null; audioBitrateK: number; preset: string; supersample: number }

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export function resolveRenderSettings(aspect: "16:9" | "9:16" | "1:1" | string, env: NodeJS.ProcessEnv = process.env): RenderSettings {
  const shortSide = Math.max(240, Number(env.RENDER_HEIGHT || 1080)); // the SHORT side of the frame (1080 => 1080p)
  const long = even((shortSide * 16) / 9);
  const [width, height] = aspect === "9:16" ? [even(shortSide), long] : aspect === "1:1" ? [even(shortSide), even(shortSide)] : [long, even(shortSide)];
  const fps = Number(env.RENDER_FPS || 24);
  if (!(fps >= 1 && fps <= 60)) throw new Error(`RENDER_FPS must be between 1 and 60 (got ${env.RENDER_FPS}).`);
  return {
    width, height, fps,
    crf: Number(env.RENDER_CRF || 18),
    videoBitrateK: env.RENDER_VIDEO_BITRATE_K ? Number(env.RENDER_VIDEO_BITRATE_K) : null,
    audioBitrateK: Number(env.RENDER_AUDIO_BITRATE_K || 192),
    preset: env.RENDER_PRESET || "medium",
    supersample: Number(env.RENDER_SUPERSAMPLE || 1.5),
  };
}

export interface SceneVideoOptions {
  source: { kind: "image" | "video"; file: string };
  timeline: SceneTimeline;
  settings: RenderSettings;
  out: string;
  workDir: string;
  rigs?: RigSpec[];
  fadeInSec?: number; // from the PREVIOUS scene's dip transition
  camera?: boolean; // default true
}

export interface SceneVideoResult { args: string[]; approximatedVisemes: string[]; frames: number }

export async function buildSceneVideoArgs(o: SceneVideoOptions): Promise<SceneVideoResult> {
  const { timeline: tl, settings: s } = o;
  const D = tl.duration, fps = s.fps;
  const SW = even(s.width * s.supersample), SH = even(s.height * s.supersample);
  const args: string[] = ["-y", "-v", "error"];
  if (o.source.kind === "image") args.push("-loop", "1", "-framerate", String(fps), "-t", String(D), "-i", o.source.file);
  else args.push("-i", o.source.file);

  const chain: string[] = [];
  // Source clip shorter than the audio-derived scene: HOLD its last frame (audio wins, dialogue is never cut).
  const hold = o.source.kind === "video" ? `tpad=stop_mode=clone:stop_duration=${D},trim=duration=${D},setpts=PTS-STARTPTS,` : "";
  chain.push(`[0:v]${hold}scale=${SW}:${SH}:force_original_aspect_ratio=increase,crop=${SW}:${SH},setsar=1,fps=${fps},format=yuv420p[base]`);
  let label = "base";
  let approx: string[] = [];
  if (o.rigs && o.rigs.length > 0) {
    const pb = buildPuppetGraph(o.rigs, tl, { width: SW, height: SH, fps, firstInputIndex: 1, baseLabel: label });
    args.push(...pb.inputArgs);
    chain.push(pb.filter);
    label = pb.outLabel;
    approx = pb.approximatedVisemes;
  }
  const cam = o.camera === false ? `scale=${s.width}:${s.height}` : buildCameraFilter(tl.camera, { width: s.width, height: s.height, fps });
  const fades: string[] = [];
  const fin = o.fadeInSec ?? 0;
  if (fin > 0) fades.push(`fade=t=in:st=0:d=${fin}`);
  if (tl.transition.type === "dip" || tl.transition.type === "fadeblack") {
    const half = tl.transition.type === "dip" ? tl.transition.duration / 2 : tl.transition.duration;
    if (half > 0) fades.push(`fade=t=out:st=${Math.max(0, D - half)}:d=${half}`);
  }
  chain.push(`[${label}]${cam},setsar=1,${fades.length ? fades.join(",") + "," : ""}format=yuv420p,trim=duration=${D},setpts=PTS-STARTPTS[v]`);

  const scriptPath = path.join(o.workDir, `scene-${tl.sceneNumber}-graph.txt`);
  await fs.writeFile(scriptPath, chain.join(";\n"), "utf8");
  const frames = Math.round(D * fps);
  args.push("-filter_complex_script", scriptPath, "-map", "[v]", "-an", "-frames:v", String(frames), "-r", String(fps),
    "-c:v", "libx264", "-preset", s.preset, "-pix_fmt", "yuv420p", "-profile:v", "high", "-g", String(fps * 2), "-movflags", "+faststart");
  if (s.videoBitrateK) args.push("-b:v", `${s.videoBitrateK}k`, "-maxrate", `${Math.round(s.videoBitrateK * 1.5)}k`, "-bufsize", `${s.videoBitrateK * 2}k`);
  else args.push("-crf", String(s.crf));
  args.push(o.out);
  return { args, approximatedVisemes: approx, frames };
}

export async function renderSceneVideo(o: SceneVideoOptions): Promise<SceneVideoResult> {
  const r = await buildSceneVideoArgs(o);
  await runProcess(getBinaries().ffmpeg, r.args, { timeoutMs: 20 * 60_000 });
  return r;
}

function concatEntry(file: string): string { return `file '${file.split(path.sep).join("/").replace(/'/g, "'\\''")}'`; }

export interface AssembleOptions { sceneVideos: string[]; audio: string; subtitles?: string | null; settings: RenderSettings; out: string; workDir: string }

/** Stream-copies the (identically encoded) scene videos, encodes the master mix to AAC, optional soft subtitles. */
export async function assembleFinal(o: AssembleOptions): Promise<string[]> {
  const list = path.join(o.workDir, "concat-list.txt");
  await fs.writeFile(list, o.sceneVideos.map(concatEntry).join("\n"), "utf8");
  const args = ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-i", o.audio];
  if (o.subtitles) args.push("-i", o.subtitles);
  args.push("-map", "0:v:0", "-map", "1:a:0");
  if (o.subtitles) args.push("-map", "2:0");
  args.push("-c:v", "copy", "-c:a", "aac", "-b:a", `${o.settings.audioBitrateK}k`, "-ar", "48000", "-ac", "2");
  if (o.subtitles) args.push("-c:s", "mov_text");
  args.push("-movflags", "+faststart", o.out);
  await runProcess(getBinaries().ffmpeg, args, { timeoutMs: 20 * 60_000 });
  return args;
}
