// Small ffmpeg-backed helpers used by pipeline stages (kept out of the stages so they stay injectable in tests).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SceneTimeline } from "./types";
import { renderSceneStems } from "./mixer";
import { probeMedia } from "./validate";

/** One speaker's dialogue placed on the scene timeline (all other time is silence), as a WAV buffer. */
export async function buildSpeakerStem(tl: SceneTimeline, speakerId: string, files: Record<string, Buffer>): Promise<Buffer> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "avg-stem-"));
  try {
    const clips = [];
    for (const s of tl.segments.filter((x) => x.characterId === speakerId)) {
      const buf = files[s.segmentId]; if (!buf) continue;
      const f = path.join(dir, `${s.segmentId}.bin`); await fs.writeFile(f, buf);
      clips.push({ file: f, start: s.startTime });
    }
    const out = path.join(dir, "stem.wav");
    await renderSceneStems({ duration: tl.duration, dialogue: clips, sfx: [] }, { dialogue: out, sfx: path.join(dir, "unused.wav") });
    return await fs.readFile(out);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

export async function validateVideoBuffer(data: Buffer): Promise<{ ok: boolean; durationSeconds: number; reason?: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "avg-vid-"));
  try {
    const f = path.join(dir, "clip.mp4"); await fs.writeFile(f, data);
    const info = await probeMedia(f);
    if (!info.streams.some((s) => s.codec_type === "video")) return { ok: false, durationSeconds: 0, reason: "no video stream" };
    if (!(info.formatDuration > 0)) return { ok: false, durationSeconds: 0, reason: "zero duration" };
    return { ok: true, durationSeconds: info.formatDuration };
  } catch (e) { return { ok: false, durationSeconds: 0, reason: (e as Error).message.slice(0, 120) }; }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}
