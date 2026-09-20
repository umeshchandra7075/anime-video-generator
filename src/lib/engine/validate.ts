import fs from "node:fs/promises";
import { getBinaries, runProcess } from "./binaries";

export interface StreamInfo { codec_type?: string; codec_name?: string; width?: number; height?: number; pix_fmt?: string; r_frame_rate?: string; avg_frame_rate?: string; duration?: string; sample_rate?: string; channels?: number; nb_frames?: string; profile?: string }
export interface MediaInfo { streams: StreamInfo[]; formatDuration: number; sizeBytes: number; formatName: string }

export async function probeMedia(file: string): Promise<MediaInfo> {
  const { stdout } = await runProcess(getBinaries().ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { timeoutMs: 60_000 });
  const j = JSON.parse(stdout.toString("utf8")) as { streams?: StreamInfo[]; format?: { duration?: string; size?: string; format_name?: string } };
  return { streams: j.streams ?? [], formatDuration: Number(j.format?.duration ?? 0), sizeBytes: Number(j.format?.size ?? 0), formatName: j.format?.format_name ?? "" };
}

function fpsOf(s: StreamInfo | undefined): number {
  const raw = s?.avg_frame_rate && s.avg_frame_rate !== "0/0" ? s.avg_frame_rate : s?.r_frame_rate ?? "0/1";
  const [a, b] = raw.split("/").map(Number);
  return b ? a! / b : 0;
}

export interface ExpectedMedia { width: number; height: number; fps: number; durationSec?: number; durationToleranceSec?: number; minBytes?: number; requireAudio?: boolean }
export interface Check { name: string; ok: boolean; detail: string }
export interface FinalValidation { ok: boolean; checks: Check[]; info: { durationSec: number; videoDurationSec: number; audioDurationSec: number; width: number; height: number; fps: number; videoCodec: string; audioCodec: string; sizeBytes: number } | null }

/** Gate for marking a render COMPLETE. Every check is real: container, codecs, geometry,
 * frame rate, audio/video length agreement, expected length, and a full decode pass. */
export async function validateFinalMp4(file: string, exp: ExpectedMedia): Promise<FinalValidation> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => { checks.push({ name, ok, detail }); return ok; };

  const st = await fs.stat(file).catch(() => null);
  if (!add("file exists", !!st, st ? `${st.size} bytes` : "missing")) return { ok: false, checks, info: null };
  add("file size", st!.size >= (exp.minBytes ?? 10_000), `${st!.size} bytes`);

  let info: MediaInfo;
  try { info = await probeMedia(file); } catch (e) { add("ffprobe readable", false, (e as Error).message); return { ok: false, checks, info: null }; }
  add("ffprobe readable", true, info.formatName);
  const v = info.streams.find((s) => s.codec_type === "video"), a = info.streams.find((s) => s.codec_type === "audio");
  add("video stream", !!v, v ? `${v.codec_name}` : "none");
  if (exp.requireAudio !== false) add("audio stream", !!a, a ? `${a.codec_name}` : "none");
  add("duration > 0", info.formatDuration > 0, `${info.formatDuration.toFixed(3)}s`);
  add("video codec is H.264", v?.codec_name === "h264", String(v?.codec_name));
  if (a) add("audio codec is AAC", a.codec_name === "aac", String(a.codec_name));
  add("pixel format yuv420p", v?.pix_fmt === "yuv420p", String(v?.pix_fmt));
  add("resolution", v?.width === exp.width && v?.height === exp.height, `${v?.width}x${v?.height} (expected ${exp.width}x${exp.height})`);
  const fps = fpsOf(v);
  add("frame rate", Math.abs(fps - exp.fps) <= 0.05, `${fps.toFixed(3)} (expected ${exp.fps})`);
  const vd = Number(v?.duration ?? info.formatDuration), ad = Number(a?.duration ?? 0);
  if (a) add("audio/video length agree", Math.abs(vd - ad) <= 0.25, `video ${vd.toFixed(3)}s vs audio ${ad.toFixed(3)}s`);
  if (exp.durationSec !== undefined) {
    const tol = exp.durationToleranceSec ?? 0.5;
    add("length matches timeline", Math.abs(info.formatDuration - exp.durationSec) <= tol, `${info.formatDuration.toFixed(3)}s vs planned ${exp.durationSec.toFixed(3)}s (tol ${tol}s)`);
  }
  // Full decode: catches truncated/corrupt streams that ffprobe alone accepts.
  try {
    const { stderr } = await runProcess(getBinaries().ffmpeg, ["-v", "error", "-xerror", "-i", file, "-f", "null", "-"], { timeoutMs: 10 * 60_000 });
    add("full decode without errors", stderr.trim() === "", stderr.trim().slice(0, 200) || "clean");
  } catch (e) { add("full decode without errors", false, (e as Error).message.slice(0, 200)); }

  return {
    ok: checks.every((c) => c.ok), checks,
    info: { durationSec: info.formatDuration, videoDurationSec: vd, audioDurationSec: ad, width: v?.width ?? 0, height: v?.height ?? 0, fps, videoCodec: v?.codec_name ?? "", audioCodec: a?.codec_name ?? "", sizeBytes: info.sizeBytes },
  };
}
