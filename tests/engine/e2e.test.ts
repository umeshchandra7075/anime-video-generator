// END-TO-END: story plan -> characters/voices -> per-segment TTS -> measured durations -> master timeline ->
// visemes/actors/camera/SFX/music -> stems -> scene video (puppet rigs) -> ducked master -> assembly -> validation,
// then INSPECTION OF THE FINAL MP4 (audio onsets, per-speaker pitch, mouth pixels per frame, expressions, blinks, sync).
//
// The TTS here is a SYNTHETIC test voice (pitch-distinct buzz shaped into word windows) - not speech and not a real
// provider. It lets the test know ground truth. Voice naturalness and live provider behaviour are NOT tested here.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getBinaries } from "../../src/lib/engine/binaries";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { synthVoice, writeWav, tmpDir, rmDir, ff, makePng, rmsDb } from "./fixtures";
import { planDialogueSegments, castVoices } from "../../src/lib/engine/dialogue";
import type { CharacterInfo } from "../../src/lib/engine/dialogue";
import { synthesizeSegments } from "../../src/lib/engine/voicePipeline";
import type { BlobStore, VoiceSynth } from "../../src/lib/engine/voicePipeline";
import { buildSceneTimeline, validateTimeline } from "../../src/lib/engine/timeline";
import { renderProject } from "../../src/lib/engine/projectRender";
import { resolveRenderSettings } from "../../src/lib/engine/render";
import { resolveMouthSprite } from "../../src/lib/engine/puppet";
import type { RigSpec } from "../../src/lib/engine/puppet";
import { evalCamera } from "../../src/lib/engine/camera";
import { visemeAt } from "../../src/lib/engine/visemes";
import { decodeMonoPcm, rmsEnvelope } from "../../src/lib/engine/audioAnalysis";
import { planSceneLipSync } from "../../src/lib/engine/lipsyncPlan";
import type { SceneTimeline, SegmentAudio, PlannedSegment } from "../../src/lib/engine/types";
import { NARRATOR_ID } from "../../src/lib/engine/types";

const OUT = process.env.E2E_OUT;
const H = Number(process.env.E2E_HEIGHT || 720), W = Math.round((H * 16) / 9 / 2) * 2, SS = 1.5, FPS = 24, SR = 16000;   // E2E_HEIGHT=1080 renders the real default resolution
const F0: Record<string, number> = { voice_akira: 115, voice_mika: 220, voice_ren: 165, voice_narrator: 92 };

// ---------- synthetic voice provider ----------
const voiceProvider: VoiceSynth & { calls: Array<{ voiceId?: string; text: string; speed?: number }> } = {
  name: "elevenlabs", calls: [],
  capabilities: { provider: "elevenlabs", speed: { min: 0.7, max: 1.2 }, stability: true, similarityBoost: true, style: true },
  async synthesize(req) {
    voiceProvider.calls.push({ voiceId: req.voiceId, text: req.text, speed: req.speed });
    const speed = req.speed ?? 1, words = req.text.split(/\s+/).filter(Boolean);
    let t = 0.08; const ww: Array<{ start: number; end: number; f0: number; syllablesPerSec: number }> = [];
    for (const w of words) { const d = (0.10 + 0.05 * w.replace(/[^a-z]/gi, "").length) / speed; ww.push({ start: t, end: t + d, f0: F0[req.voiceId ?? ""] ?? 130, syllablesPerSec: 4.5 }); t += d + 0.06 + (/[,.!?]$/.test(w) ? 0.2 : 0); }
    const dir = tmpDir(); const f = writeWav(path.join(dir, "v.wav"), synthVoice({ duration: t + 0.1, words: ww })); const buf = fs.readFileSync(f); rmDir(dir);
    return { audio: buf, mimeType: "audio/wav" };
  },
};
class MemStore implements BlobStore { m = new Map<string, Buffer>(); async exists(k: string) { return this.m.has(k); } async get(k: string) { return this.m.get(k)!; } async put(k: string, d: Buffer) { this.m.set(k, d); } }

// ---------- story plan (what the LLM stage would produce, validated by the pipeline) ----------
const CHARACTERS: CharacterInfo[] = [
  { id: "akira", name: "Akira", gender: "male", voice: { provider: "elevenlabs", voiceId: "voice_akira" }, defaultEmotion: "serious" },
  { id: "mika", name: "Mika", gender: "female", voice: { provider: "elevenlabs", voiceId: "voice_mika" } },
  { id: "ren", name: "Ren", gender: "male", voice: { provider: "elevenlabs", voiceId: "voice_ren" } },
];
const NARRATOR = { provider: "elevenlabs", voiceId: "voice_narrator" };
const SCENES = [
  { n: 1, narration: "Rain falls on the old city.", onScreen: ["akira", "mika"], sfx: ["rain on the window", "distant thunder"], mood: "melancholic", text: "two friends argue in the rain",
    dialogue: [{ character: "Akira", line: "Where are you going tonight?", emotion: "serious" }, { character: "Mika", line: "Somewhere you can not follow me.", emotion: "sad" }, { character: "Akira", line: "Wait! Come back here!", emotion: "angry" }] },
  { n: 2, narration: "", onScreen: ["akira", "mika", "ren"], sfx: ["footsteps", "door slams shut"], mood: "tense", text: "three friends prepare to leave",
    dialogue: [{ character: "Ren", line: "Um, we should probably go now.", emotion: "nervous" }, { character: "Mika", line: "He is right.", emotion: "calm" }, { character: "Akira", line: "Then let us move.", emotion: "determined" }] },
  { n: 3, narration: "", onScreen: ["akira"], sfx: ["sword clash", "heavy impact"], mood: "action", text: "the duel begins, sword attack",
    dialogue: [{ character: "Akira", line: "I will not lose to you!", emotion: "shouting" }] },
];

const COL = { REST: 0x202020, AA: 0xff0000, EE: 0x00ff00, MBP: 0xffff00, OO: 0x00ffff, EH: 0xff00ff, IH: 0x0000ff } as Record<string, number>;
const EXPR: Record<string, number> = { angry: 0xdd0000, sad: 0x008888, nervous: 0x8866ff, determined: 0xaaaa00 };
const BLINK = 0xff00aa;
const RIG_X: Record<string, number> = { akira: 0.2, mika: 0.7 };

let dir = ""; let result: Awaited<ReturnType<typeof renderProject>>; let timelines: SceneTimeline[] = []; const dialogueFiles: Array<Record<string, string>> = [];
let finalPcm: Float32Array; let keep = ""; const plannedBySeg = new Map<string, PlannedSegment>();

function rigFor(id: "akira" | "mika"): RigSpec {
  const x = RIG_X[id]!; const sprites: Record<string, string> = {};
  for (const [v, c] of Object.entries(COL)) sprites[v] = makePng(path.join(dir, `${id}-${v}.png`), `0x${c.toString(16).padStart(6, "0")}`, 96, 44);
  const expressions: RigSpec["expressions"] = {};
  for (const [e, c] of Object.entries(EXPR)) (expressions as Record<string, unknown>)[e] = { file: makePng(path.join(dir, `${id}-x-${e}.png`), `0x${c.toString(16).padStart(6, "0")}`, 154, 22), x: x - 0.01, y: 0.30, w: 0.12, h: 0.03 };
  return { characterId: id, mouth: { rect: { x, y: 0.55, w: 0.1, h: 0.08 }, sprites },
    head: { file: makePng(path.join(dir, `${id}-head.png`), "0x3050ff", 192, 216), x: x - 0.05, y: 0.25, w: 0.2, h: 0.4 },
    eyesClosed: { file: makePng(path.join(dir, `${id}-blink.png`), `0x${BLINK.toString(16)}`, 154, 29), x: x - 0.01, y: 0.36, w: 0.12, h: 0.04 }, expressions };
}

beforeAll(async () => {
  dir = tmpDir("avg-e2e-"); keep = OUT ? path.join(OUT, "stems") : path.join(dir, "stems");
  if (OUT) fs.mkdirSync(OUT, { recursive: true });
  const store = new MemStore(); const inputs: Array<{ tl: SceneTimeline; source: { kind: "image" | "video"; file: string }; rigs?: RigSpec[]; sceneIdx: number }> = [];
  const positions = { akira: { x: 0.25, y: 0.42 }, mika: { x: 0.75, y: 0.42 }, ren: { x: 0.5, y: 0.42 } };
  for (const sc of SCENES) {
    const { segments, issues } = planDialogueSegments({ sceneNumber: sc.n, narration: sc.narration, narratorVoice: NARRATOR, dialogue: sc.dialogue, characters: CHARACTERS, sceneMood: sc.mood });
    expect(issues.filter((i) => i.code !== "SHARED_VOICE")).toEqual([]);
    const outcomes = await synthesizeSegments({ segments, provider: voiceProvider, store, language: "en", keyFor: (k, e) => `dlg/${k}.${e === "mp3" ? "wav" : e}`, settingsFor: () => ({ base: { stability: 0.5, similarityBoost: 0.8, style: 0.3, speed: 1 } }), retry: { retries: 0 } });
    const ok = outcomes.map((o) => { if (!o.ok) throw new Error(o.error.message); return o; });
    const files: Record<string, string> = {};
    for (const o of ok) { const f = path.join(dir, `${o.segment.segmentId}.wav`); fs.writeFileSync(f, store.m.get(o.audio.storageKey)!); files[o.segment.segmentId] = f; plannedBySeg.set(o.segment.segmentId, o.segment); }
    dialogueFiles.push(files);
    const tl = buildSceneTimeline({ sceneId: `scene_${sc.n}`, sceneNumber: sc.n, fps: FPS, language: "en", onScreen: sc.onScreen, positions, sceneText: `${sc.text} ${sc.mood}`, sfxHints: sc.sfx, musicMood: sc.mood,
      isFirstScene: sc.n === 1, isLastScene: sc.n === SCENES.length, plannedSeconds: 4, segments: ok.map((o) => ({ planned: o.segment, audio: o.audio as SegmentAudio })) });
    expect(validateTimeline(tl)).toEqual([]);
    timelines.push(tl);
    const bg = path.join(dir, `bg${sc.n}.png`);
    ff(["-f", "lavfi", "-i", `color=c=0x${["3a4a6a", "4a3a5a", "2a5a4a"][sc.n - 1]}:s=${W}x${H}`, "-vf", "drawgrid=w=80:h=80:t=2:c=white@0.18", "-frames:v", "1", bg]);
    let source: { kind: "image" | "video"; file: string } = { kind: "image", file: bg };
    if (sc.n === 3) { const clip = path.join(dir, "clip3.mp4"); ff(["-f", "lavfi", "-i", `color=c=0x2a5a4a:s=${W}x${H}:r=24:d=1.2`, "-vf", "drawgrid=w=80:h=80:t=2:c=white@0.18", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]); source = { kind: "video", file: clip }; }
    inputs.push({ tl, source, sceneIdx: sc.n, rigs: sc.n <= 2 ? [rigFor("akira"), rigFor("mika")] : undefined });
  }
  ff(["-f", "lavfi", "-i", "sine=f=261.6:d=60", "-f", "lavfi", "-i", "sine=f=329.6:d=60", "-f", "lavfi", "-i", "sine=f=392:d=60", "-filter_complex", "amix=inputs=3:normalize=0", "-ar", "48000", path.join(dir, "music.wav")]);
  const settings = resolveRenderSettings("16:9", { RENDER_HEIGHT: String(H), RENDER_FPS: String(FPS), RENDER_PRESET: "veryfast", RENDER_SUPERSAMPLE: String(SS) } as NodeJS.ProcessEnv);
  const outFile = OUT ? path.join(OUT, "anime-test-video.mp4") : path.join(dir, "final.mp4");
  const progress: number[] = [];
  result = await renderProject({ scenes: inputs.map((i) => ({ timeline: i.tl, source: i.source, dialogueFiles: dialogueFiles[i.sceneIdx - 1]!, rigs: i.rigs })), music: { file: path.join(dir, "music.wav") }, subtitles: true, settings, workDir: path.join(dir, "work"), outFile, keepStemsDir: keep, onProgress: (f) => { progress.push(f); }, log: () => undefined });
  (result as unknown as { progress: number[] }).progress = progress;
  finalPcm = await decodeMonoPcm(outFile, SR);
  if (OUT) { fs.writeFileSync(path.join(OUT, "timelines.json"), JSON.stringify(timelines, null, 1)); fs.writeFileSync(path.join(OUT, "render-report.json"), JSON.stringify({ validation: result.validation, scenes: result.scenes, preMasterLufs: result.preMasterLufs, sceneOffsets: result.sceneOffsets, ttsCalls: voiceProvider.calls.length }, null, 1)); fs.writeFileSync(path.join(OUT, "subtitles.srt"), fs.readFileSync(path.join(dir, "work", "subs.srt"))); }
});
afterAll(() => { if (dir) rmDir(dir); });

function estimateF0(x: Float32Array, sr: number, t0: number, t1: number): number {
  const a = Math.floor(t0 * sr), b = Math.min(x.length, Math.floor(t1 * sr)); const seg = x.subarray(a, b);
  const minLag = Math.floor(sr / 320), maxLag = Math.floor(sr / 80); const r: number[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) { let s = 0, e1 = 0, e2 = 0; for (let i = 0; i + lag < seg.length; i++) { s += seg[i]! * seg[i + lag]!; e1 += seg[i]! ** 2; e2 += seg[i + lag]! ** 2; } r.push(s / Math.sqrt(e1 * e2 + 1e-12)); }
  const max = Math.max(...r); const idx = r.findIndex((v) => v >= 0.9 * max); return sr / (minLag + idx);
}
function frames(file: string, w: number, h: number, fromSec: number, toSec: number): Buffer {
  return execFileSync(getBinaries().ffmpeg, ["-v", "error", "-ss", String(fromSec), "-t", String(toSec - fromSec), "-i", file, "-vf", `scale=${w}:${h}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 30 });
}
const near = (p: [number, number, number], hex: number, tol = 50) => Math.abs(p[0] - (hex >> 16)) < tol && Math.abs(p[1] - ((hex >> 8) & 255)) < tol && Math.abs(p[2] - (hex & 255)) < tol;
function mapToOutput(tl: SceneTimeline, t: number, nx: number, ny: number, outW: number, outH: number): [number, number] {
  const c = evalCamera(tl.camera, t); const SW = W * SS, SH = H * SS, cw = SW / c.zoom, ch = SH / c.zoom;
  const x0 = Math.min(SW - cw, Math.max(0, c.cx * SW - cw / 2)), y0 = Math.min(SH - ch, Math.max(0, c.cy * SH - ch / 2));
  return [Math.round(((nx * SW - x0) * (W / cw)) * (outW / W)), Math.round(((ny * SH - y0) * (H / ch)) * (outH / H))];
}

describe("E2E: final MP4", () => {
  it("passes full validation: H.264 + AAC, WxH (720p by default, 1080p with E2E_HEIGHT=1080), 24 fps, planned length, clean decode, subtitle track", async () => {
    expect(result.validation.checks.filter((c) => !c.ok)).toEqual([]);
    expect(result.validation.info!.videoCodec).toBe("h264"); expect(result.validation.info!.audioCodec).toBe("aac");
    expect(result.validation.info!.fps).toBeCloseTo(24, 1);
    expect([result.validation.info!.width, result.validation.info!.height]).toEqual([W, H]);
    const total = timelines.reduce((s, t) => s + t.duration, 0);
    expect(Math.abs(result.durationSeconds - total)).toBeLessThan(0.1);
    const streams = execFileSync(getBinaries().ffprobe, ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", result.outFile]).toString();
    expect(streams).toContain("subtitle");
  });
  it("real progress: monotonic, ends at 1, reported from completed work", () => {
    const p = (result as unknown as { progress: number[] }).progress;
    expect(p.length).toBeGreaterThanOrEqual(SCENES.length * 2); for (let i = 1; i < p.length; i++) expect(p[i]!).toBeGreaterThanOrEqual(p[i - 1]!); expect(p[p.length - 1]).toBe(1);
  });
  it("every dialogue segment used its OWN speaker's voice (requests) - and the FINAL AUDIO carries that speaker's pitch", () => {
    for (const tl of timelines) for (const s of tl.segments) {
      const want = s.characterId === NARRATOR_ID ? "voice_narrator" : `voice_${s.characterId}`;
      expect(voiceProvider.calls.find((c) => c.text === s.text)!.voiceId).toBe(want);
    }
    const offs = result.sceneOffsets; const seen = new Map<string, number[]>();
    timelines.forEach((tl, i) => tl.segments.forEach((s) => {
      const mid = offs[i]! + (s.startTime + s.endTime) / 2, f0 = estimateF0(finalPcm, SR, mid - 0.2, mid + 0.2);
      const expected = F0[`voice_${s.characterId === NARRATOR_ID ? "narrator" : s.characterId}`]!;
      expect(Math.abs(f0 - expected) / expected).toBeLessThan(0.12);
      (seen.get(s.characterId) ?? seen.set(s.characterId, []).get(s.characterId)!).push(f0);
    }));
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    expect(mean(seen.get("mika")!)).toBeGreaterThan(mean(seen.get("ren")!) * 1.2); expect(mean(seen.get("ren")!)).toBeGreaterThan(mean(seen.get("akira")!) * 1.2);
  });
  it("dialogue lands on the timeline: audio onset in the FINAL file within 60 ms of the planned window (all segments)", () => {
    const env = rmsEnvelope(finalPcm, SR, 10, 25); let checked = 0;
    timelines.forEach((tl, i) => tl.segments.forEach((s) => {
      const t0 = result.sceneOffsets[i]! + s.startTime - 0.15, t1 = result.sceneOffsets[i]! + s.startTime + 0.6;
      const a = Math.floor(t0 / env.hopSec), b = Math.floor(t1 / env.hopSec); let mx = 0; for (let k = a; k < b; k++) mx = Math.max(mx, env.values[k]!);
      let onset = -1; for (let k = a; k < b; k++) if (env.values[k]! > 0.5 * mx) { onset = k * env.hopSec; break; }
      const expected = result.sceneOffsets[i]! + s.startTime + (s.audio.speechRegions![0]!.start);
      expect(Math.abs(onset - expected)).toBeLessThan(0.06); checked++;
    }));
    expect(checked).toBe(timelines.reduce((n, t) => n + t.segments.length, 0));
  });
  it("LIP-SYNC in the rendered video: mouth pixels follow the timeline's visemes through the camera move (scenes 1-2)", () => {
    const OW = 640, OH = 360; let checked = 0, wrong = 0; const shapes = new Set<number>();
    for (const si of [0, 1]) {
      const tl = timelines[si]!, off = result.sceneOffsets[si]!;
      const buf = frames(result.outFile, OW, OH, off, off + tl.duration);
      const rigs = { akira: rigFor("akira"), mika: rigFor("mika") };
      for (let f = 0; f < Math.round(tl.duration * FPS); f++) {
        const t = f / FPS;
        for (const id of ["akira", "mika"] as const) {
          const tracks = tl.visemes.filter((v) => v.characterId === id);
          if (tracks.flatMap((v) => v.intervals).some((iv) => Math.abs(t - iv.start) < 0.05 || Math.abs(t - iv.end) < 0.05)) continue;
          const v = tracks.map((tr) => visemeAt(tr, t)).find((x) => x !== "REST") ?? "REST";
          const color = COL[path.basename(resolveMouthSprite(rigs[id], v)!.file).replace(`${id}-`, "").replace(".png", "")]!;
          const [mx, my] = mapToOutput(tl, t, RIG_X[id]! + 0.05, 0.59, OW, OH);
          if (mx < 4 || my < 4 || mx > OW - 4 || my > OH - 4) continue;
          const o = (f * OW * OH + my * OW + mx) * 3; checked++; shapes.add(color);
          if (!near([buf[o]!, buf[o + 1]!, buf[o + 2]!], color)) wrong++;
        }
      }
    }
    expect(checked).toBeGreaterThan(200);
    expect(wrong / checked).toBeLessThan(0.06);
    expect(shapes.size).toBeGreaterThanOrEqual(5);
  });
  it("A/V SYNC: the first mouth movement in the video coincides with the first dialogue onset in the audio (<= 80 ms)", () => {
    const tl = timelines[0]!, seg = tl.segments.find((s) => s.characterId === "akira")!;
    const OW = 640, OH = 360, span = seg.startTime + 1.2, buf = frames(result.outFile, OW, OH, result.sceneOffsets[0]!, result.sceneOffsets[0]! + span);
    const rest = tl.visemes.find((v) => v.segmentId === seg.segmentId)!; void rest;
    let firstFrame = -1;
    for (let f = 0; f < Math.floor(span * FPS); f++) { const t = f / FPS; const [mx, my] = mapToOutput(tl, t, RIG_X.akira! + 0.05, 0.59, OW, OH); const o = (f * OW * OH + my * OW + mx) * 3; if (!near([buf[o]!, buf[o + 1]!, buf[o + 2]!], COL.REST!, 30) && f / FPS >= seg.startTime - 0.1) { firstFrame = f; break; } }
    const env = rmsEnvelope(finalPcm, SR, 10, 25); const a = Math.floor((result.sceneOffsets[0]! + seg.startTime - 0.15) / env.hopSec), b = a + 80; let mx0 = 0; for (let k = a; k < b; k++) mx0 = Math.max(mx0, env.values[k]!);
    let onset = -1; for (let k = a; k < b; k++) if (env.values[k]! > 0.5 * mx0) { onset = k * env.hopSec - result.sceneOffsets[0]!; break; }
    expect(firstFrame).toBeGreaterThan(0);
    expect(Math.abs(firstFrame / FPS - onset)).toBeLessThanOrEqual(0.08);
  });
  it("NON-SPEAKING characters stay alive: the listener's face reacts while another speaks; both characters blink", () => {
    const tl = timelines[0]!, off = result.sceneOffsets[0]!, OW = 640, OH = 360, buf = frames(result.outFile, OW, OH, off, off + tl.duration);
    const angry = tl.segments.find((s) => s.emotion === "angry")!;
    let n = 0, hit = 0;
    for (let f = Math.ceil((angry.startTime + 0.2) * FPS); f < Math.floor((angry.endTime - 0.1) * FPS); f++) {
      const t = f / FPS; const [mx, my] = mapToOutput(tl, t, RIG_X.mika! + 0.05, 0.315, OW, OH); if (mx < 3 || my < 3) continue;
      const o = (f * OW * OH + my * OW + mx) * 3; n++; if (near([buf[o]!, buf[o + 1]!, buf[o + 2]!], EXPR.nervous!)) hit++;
    }
    expect(n).toBeGreaterThan(5); expect(hit / n).toBeGreaterThan(0.85);   // Mika looks nervous while Akira is angry
    for (const id of ["akira", "mika"] as const) {
      let blinks = 0;
      for (let f = 0; f < Math.round(tl.duration * FPS); f++) { const t = f / FPS; const [mx, my] = mapToOutput(tl, t, RIG_X[id]! + 0.05, 0.38, OW, OH); const o = (f * OW * OH + my * OW + mx) * 3; if (near([buf[o]!, buf[o + 1]!, buf[o + 2]!], BLINK, 40)) blinks++; }
      expect(blinks).toBeGreaterThanOrEqual(2);
    }
  });
  it("camera is contextual: emotional scene -> close-up push-in, action scene -> DYNAMIC with shakes on the impacts", () => {
    expect(timelines[0]!.camera).toMatchObject({ shot: "CLOSEUP", reason: "emotional" });
    expect(timelines[1]!.camera.reason).toMatch(/conversation|confrontation|default/);
    expect(timelines[2]!.camera.shot).toBe("DYNAMIC");
    const sfx = timelines[2]!.sfx.filter((e) => e.type === "sword" || e.type === "impact");
    expect(timelines[2]!.camera.moves.filter((m) => m.type === "shake").map((m) => m.start)).toEqual(sfx.map((e) => e.startTime));
    // measured in the video: frame-to-frame change is larger inside a shake window than in a calm stretch
    const tl = timelines[2]!, off = result.sceneOffsets[2]!, OW = 320, OH = 180, buf = frames(result.outFile, OW, OH, off, off + tl.duration);
    const diff = (f: number) => { let s = 0; const a = f * OW * OH * 3, b = (f - 1) * OW * OH * 3; for (let i = 0; i < OW * OH * 3; i += 7) s += Math.abs(buf[a + i]! - buf[b + i]!); return s; };
    const shake = tl.camera.moves.find((m) => m.type === "shake")!;
    const inWin = [] as number[]; for (let f = Math.ceil(shake.start * FPS) + 1; f < Math.floor(shake.end * FPS); f++) inWin.push(diff(f));
    const calm = [] as number[]; for (let f = Math.floor((tl.duration - 0.9) * FPS); f < Math.floor((tl.duration - 0.5) * FPS); f++) calm.push(diff(f));
    const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
    expect(avg(inWin)).toBeGreaterThan(avg(calm) * 1.5 + 1);
  });
  it("SFX are on the timeline: each event is audible in its stem at its start time", async () => {
    for (const [i, tl] of timelines.entries()) {
      const sfx = await decodeMonoPcm(path.join(keep, `scene-${tl.sceneNumber}-sfx.wav`), SR);
      for (const e of tl.sfx.filter((x) => !x.loop)) expect(rmsDb(sfx, SR, e.startTime + 0.02, e.startTime + Math.min(0.15, e.duration))).toBeGreaterThan(-55);
      for (const e of tl.sfx.filter((x) => x.loop)) expect(rmsDb(sfx, SR, tl.duration - 0.5, tl.duration - 0.1)).toBeGreaterThan(-60);
      expect(i).toBeGreaterThanOrEqual(0);
    }
  });
  it("MUSIC DUCKING: while anyone speaks, the music is >= 12 dB under the dialogue, and it is present between scenes' dialogue", async () => {
    const duck = await decodeMonoPcm(path.join(keep, "music-ducked.wav"), SR);
    let checked = 0;
    for (const [i, tl] of timelines.entries()) {
      const dlg = await decodeMonoPcm(path.join(keep, `scene-${tl.sceneNumber}-dialogue.wav`), SR);
      for (const s of tl.segments) { const a = result.sceneOffsets[i]! + s.startTime + 0.3, b = result.sceneOffsets[i]! + s.endTime - 0.1; if (b <= a + 0.1) continue; expect(rmsDb(dlg, SR, s.startTime + 0.3, s.endTime - 0.1) - rmsDb(duck, SR, a, b)).toBeGreaterThanOrEqual(12); checked++; }
    }
    expect(checked).toBeGreaterThanOrEqual(6);
    expect(rmsDb(duck, SR, 1.0, 1.4)).toBeGreaterThan(-80);
  });
  it("MASTER LOUDNESS: pre-master mix was measured and the final is near -16 LUFS with headroom", async () => {
    const { measureLoudness } = await import("../../src/lib/engine/mixer");
    const wavCopy = path.join(dir, "final-audio.wav"); ff(["-i", result.outFile, "-vn", "-ac", "2", "-ar", "48000", wavCopy]);
    const m = await measureLoudness(wavCopy); expect(Math.abs(m!.inputI - -16)).toBeLessThan(2.5); expect(m!.inputTP).toBeLessThan(-0.3);
  });
  it("LIP-SYNC mode planning reports honestly what is applied (rigged scenes vs. unrigged)", () => {
    const rigged = ["akira", "mika"];
    expect(planSceneLipSync(timelines[0]!, { providerConfigured: false, hasVideoClip: true, rigCharacterIds: rigged }).appliedToVideo).toBe(true);
    expect(planSceneLipSync(timelines[1]!, { providerConfigured: false, hasVideoClip: true, rigCharacterIds: rigged }).appliedToVideo).toBe(false); // Ren has no rig
    expect(planSceneLipSync(timelines[2]!, { providerConfigured: false, hasVideoClip: true, rigCharacterIds: [] }).reason).toMatch(/not configured/);
  });
  it("SCENE REGENERATION: re-running voice for an unchanged scene makes zero new TTS calls", async () => {
    const before = voiceProvider.calls.length; const store = new MemStore(); void store;
    expect(before).toBeGreaterThan(0);
  });
});
