import { describe, it, expect, afterEach } from "vitest";
import { getBinaries } from "../../src/lib/engine/binaries";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { tmpDir, rmDir, makePng, ff, synthVoice, writeWav } from "./fixtures";
import { planDialogueSegments } from "../../src/lib/engine/dialogue";
import { buildSceneTimeline } from "../../src/lib/engine/timeline";
import { visemeAt } from "../../src/lib/engine/visemes";
import { renderSceneVideo, assembleFinal, resolveRenderSettings } from "../../src/lib/engine/render";
import { resolveMouthSprite } from "../../src/lib/engine/puppet";
import type { RigSpec } from "../../src/lib/engine/puppet";
import { validateFinalMp4, probeMedia } from "../../src/lib/engine/validate";
import type { SceneTimeline } from "../../src/lib/engine/types";

const dirs: string[] = [];
const mk = () => { const d = tmpDir(); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmDir(dirs.pop()!); });

const chars = [{ id: "akira", name: "Akira", voice: { provider: "x", voiceId: "a" } }, { id: "mika", name: "Mika", voice: { provider: "x", voiceId: "m" } }];
function timeline(lines: Array<[string, string, number]>, fps = 24, extra: Record<string, unknown> = {}): SceneTimeline {
  const { segments } = planDialogueSegments({ sceneNumber: 1, characters: chars, dialogue: lines.map(([character, line]) => ({ character, line })) });
  return buildSceneTimeline({ sceneId: "s1", sceneNumber: 1, fps, language: "en", onScreen: ["akira", "mika"], plannedSeconds: 4, sceneText: "talk", sfxHints: [], musicMood: null, isFirstScene: false,
    segments: segments.map((planned, i) => ({ planned, audio: { storageKey: "k", mimeType: "audio/mpeg", durationSeconds: lines[i]![2], cacheKey: "c", speechRegions: [{ start: 0.05, end: lines[i]![2] - 0.05 }] } })), ...extra });
}
const S360 = resolveRenderSettings("16:9", { RENDER_HEIGHT: "360", RENDER_FPS: "24", RENDER_PRESET: "ultrafast", RENDER_CRF: "12", RENDER_SUPERSAMPLE: "1" } as NodeJS.ProcessEnv);
const S180 = resolveRenderSettings("16:9", { RENDER_HEIGHT: "240", RENDER_FPS: "24", RENDER_PRESET: "ultrafast", RENDER_SUPERSAMPLE: "1" } as NodeJS.ProcessEnv);

function frames(file: string, w: number, h: number): Buffer { return execFileSync(getBinaries().ffmpeg, ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 29 }); }
const px = (buf: Buffer, w: number, h: number, f: number, x: number, y: number): [number, number, number] => { const o = (f * w * h + y * w + x) * 3; return [buf[o]!, buf[o + 1]!, buf[o + 2]!]; };
const close = (a: [number, number, number], hex: number, tol = 45) => Math.abs(a[0] - (hex >> 16)) < tol && Math.abs(a[1] - ((hex >> 8) & 255)) < tol && Math.abs(a[2] - (hex & 255)) < tol;

const COLORS: Record<string, number> = { REST: 0x202020, AA: 0xff0000, EE: 0x00ff00, MBP: 0xffff00, OO: 0x00ffff, EH: 0xff00ff, IH: 0x0000ff };
function makeRig(d: string, id: "akira" | "mika", withHead: boolean): RigSpec {
  const sprites: Record<string, string> = {};
  for (const [v, c] of Object.entries(COLORS)) sprites[v] = makePng(path.join(d, `${id}-${v}.png`), `0x${c.toString(16).padStart(6, "0")}`, 64, 29);
  const x = id === "akira" ? 0.2 : 0.7;
  return { characterId: id, mouth: { rect: { x, y: 0.55, w: 0.1, h: 0.08 }, sprites },
    ...(withHead ? { head: { file: makePng(path.join(d, `${id}-head.png`), "0x3050ff", 128, 144), x: 0.15, y: 0.25, w: 0.2, h: 0.4 } } : {}),
    eyesClosed: { file: makePng(path.join(d, `${id}-eyes.png`), "0xff8800", 77, 14), x: x - 0.01, y: 0.36, w: 0.12, h: 0.04 } };
}

describe("puppet compositor: lip-sync from the master timeline, verified in rendered frames", () => {
  const lines: Array<[string, string, number]> = [["Akira", "map the ship", 1.4], ["Mika", "see the moon", 1.3], ["Akira", "five big boats", 1.2]];
  it("every rendered mouth pixel matches the viseme the timeline says is active; the listener's mouth stays at REST", async () => {
    const d = mk();
    const tl = timeline(lines);
    const bg = makePng(path.join(d, "bg.png"), "0x808080", 640, 360);
    const rigs = [makeRig(d, "akira", true), makeRig(d, "mika", false)];
    const out = path.join(d, "scene.mp4");
    const r = await renderSceneVideo({ source: { kind: "image", file: bg }, timeline: tl, settings: S360, out, workDir: d, rigs, camera: false });
    expect(r.frames).toBe(Math.round(tl.duration * 24));
    const buf = frames(out, 640, 360);
    let checked = 0, wrong = 0; const seen = new Set<number>();
    const mouthPx = (id: string) => (id === "akira" ? [Math.round(0.25 * 640), Math.round(0.59 * 360)] : [Math.round(0.75 * 640), Math.round(0.59 * 360)]);
    for (let f = 0; f < r.frames; f++) {
      const t = f / 24;
      for (const id of ["akira", "mika"] as const) {
        const track = tl.visemes.filter((v) => v.characterId === id);
        const near = track.flatMap((v) => v.intervals).some((iv) => Math.abs(t - iv.start) < 0.04 || Math.abs(t - iv.end) < 0.04);
        if (near) continue;
        const v = track.map((tr) => visemeAt(tr, t)).find((x) => x !== "REST") ?? "REST";
        const rig = id === "akira" ? rigs[0]! : rigs[1]!;
        const spriteFile = resolveMouthSprite(rig, v)!.file;
        const expectedColor = COLORS[path.basename(spriteFile).replace(`${id}-`, "").replace(".png", "")]!;
        const [mx, my] = mouthPx(id);
        const got = px(buf, 640, 360, f, mx!, my!);
        checked++; seen.add(expectedColor);
        if (!close(got, expectedColor)) wrong++;
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(wrong / checked).toBeLessThan(0.02);        // <2% frames (edge rounding) may disagree
    expect(seen.size).toBeGreaterThanOrEqual(4);        // multiple different mouth shapes were really shown
    // listener rest check: while Akira speaks (lead-in of the scene excluded), Mika's mouth is REST
    const a0 = tl.segments[0]!; const f = Math.round(((a0.startTime + a0.endTime) / 2) * 24);
    expect(close(px(buf, 640, 360, f, ...(mouthPx("mika") as [number, number])), COLORS.REST!)).toBe(true);
    expect(r.approximatedVisemes.length).toBeGreaterThan(0); // honest report: rig lacked sprites for some visemes
  });
  it("blinks show the eyelid sprite exactly inside blink windows", async () => {
    const d = mk();
    const tl = timeline(lines);
    const bg = makePng(path.join(d, "bg.png"), "0x808080", 640, 360);
    const rig = makeRig(d, "akira", true);
    const out = path.join(d, "scene.mp4");
    await renderSceneVideo({ source: { kind: "image", file: bg }, timeline: tl, settings: S360, out, workDir: d, rigs: [rig], camera: false });
    const buf = frames(out, 640, 360);
    const blinks = tl.actors.find((a) => a.characterId === "akira")!.events.filter((e) => e.kind === "blink");
    expect(blinks.length).toBeGreaterThanOrEqual(1);
    const ex = Math.round((0.19 + 0.06) * 640), ey = Math.round(0.38 * 360);
    let inWin = 0, inOk = 0, outWin = 0, outBad = 0;
    for (let f = 0; f < Math.round(tl.duration * 24); f++) {
      const t = f / 24;
      if (blinks.some((b) => Math.abs(t - b.start) < 0.05 || Math.abs(t - b.end) < 0.05)) continue;
      const isBlink = blinks.some((b) => t >= b.start && t < b.end);
      const eyes = close(px(buf, 640, 360, f, ex, ey), 0xff8800);
      if (isBlink) { inWin++; if (eyes) inOk++; } else { outWin++; if (eyes) outBad++; }
    }
    expect(inWin).toBeGreaterThan(0); expect(inOk / inWin).toBeGreaterThan(0.95);
    expect(outBad / outWin).toBeLessThan(0.02);
  });
  it("the head layer is alive (breathing/nod/gesture) yet stays subtle - it is not frozen and not jittery", async () => {
    const d = mk();
    const tl = timeline(lines);
    const bg = makePng(path.join(d, "bg.png"), "0x808080", 640, 360);
    const out = path.join(d, "scene.mp4");
    await renderSceneVideo({ source: { kind: "image", file: bg }, timeline: tl, settings: S360, out, workDir: d, rigs: [makeRig(d, "akira", true)], camera: false });
    const buf = frames(out, 640, 360);
    const ys: number[] = [];
    for (let f = 0; f < Math.round(tl.duration * 24); f++) {
      // head top edge: first row (scanning down at x=~0.2*640) whose pixel is head-blue
      const x = Math.round(0.17 * 640);
      let top = -1; for (let y = 60; y < 200; y++) if (close(px(buf, 640, 360, f, x, y), 0x3050ff, 60)) { top = y; break; }
      ys.push(top);
    }
    expect(ys.every((y) => y > 0)).toBe(true);
    const range = Math.max(...ys) - Math.min(...ys);
    expect(range).toBeGreaterThanOrEqual(1);
    expect(range).toBeLessThanOrEqual(10);
  });
});

describe("scene rendering + final assembly", () => {
  it("REGRESSION: mixed-source clips (different res/fps/length) are normalised so the final concat is valid", async () => {
    const d = mk();
    const still = makePng(path.join(d, "still.png"), "0x336699", 1024, 576);
    ff(["-f", "lavfi", "-i", "testsrc=s=160x90:r=15:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(d, "clip.mp4")]); // 160x90 @15fps, 1 s
    const tlA = timeline([["Akira", "hello there", 1.6]]), tlB = { ...timeline([["Mika", "and hello", 1.6]]), sceneNumber: 2, sceneId: "s2" };
    const a = path.join(d, "a.mp4"), b = path.join(d, "b.mp4");
    await renderSceneVideo({ source: { kind: "image", file: still }, timeline: tlA, settings: S180, out: a, workDir: d });
    await renderSceneVideo({ source: { kind: "video", file: path.join(d, "clip.mp4") }, timeline: tlB, settings: S180, out: b, workDir: d });
    const pa = (await probeMedia(a)).streams[0]!, pb = (await probeMedia(b)).streams[0]!;
    for (const k of ["width", "height", "pix_fmt", "codec_name", "r_frame_rate"] as const) expect(pa[k]).toEqual(pb[k]);
    expect(`${pa.width}x${pa.height}`).toBe(`${S180.width}x${S180.height}`);
    // audio: master of exactly the two scenes' length
    const total = tlA.duration + tlB.duration;
    ff(["-f", "lavfi", "-i", `sine=f=300:d=${total}`, "-ar", "48000", "-ac", "2", path.join(d, "master.wav")]);
    const out = path.join(d, "final.mp4");
    await assembleFinal({ sceneVideos: [a, b], audio: path.join(d, "master.wav"), settings: S180, out, workDir: d });
    const v = await validateFinalMp4(out, { width: S180.width, height: S180.height, fps: 24, durationSec: total, durationToleranceSec: 0.1 });
    expect(v.checks.filter((c) => !c.ok)).toEqual([]);
    expect(v.ok).toBe(true);
    expect(Math.abs(v.info!.videoDurationSec - v.info!.audioDurationSec)).toBeLessThan(0.1);
  });
  it("a source clip shorter than the audio-derived scene holds its last frame (dialogue is never cut)", async () => {
    const d = mk();
    ff(["-f", "lavfi", "-i", "testsrc=s=160x90:r=15:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(d, "clip.mp4")]);
    const tl = timeline([["Akira", "a long line of dialogue here", 3.4]]);
    const out = path.join(d, "s.mp4");
    const r = await renderSceneVideo({ source: { kind: "video", file: path.join(d, "clip.mp4") }, timeline: tl, settings: S180, out, workDir: d });
    const info = await probeMedia(out);
    expect(info.formatDuration).toBeGreaterThanOrEqual(tl.segments[0]!.endTime);
    expect(Math.abs(info.formatDuration - tl.duration)).toBeLessThan(0.06);
    expect(r.frames).toBe(Math.round(tl.duration * 24));
  });
  it("frame-quantised scene durations => video and audio stay locked over many scenes (no cumulative drift)", async () => {
    const d = mk();
    const still = makePng(path.join(d, "s.png"), "0x664422", 320, 180);
    const files: string[] = []; let total = 0;
    for (let i = 0; i < 6; i++) {
      const tl = { ...timeline([["Akira", "x", 0.937 + i * 0.211]]), sceneNumber: i + 1, sceneId: `s${i}` };
      expect(Math.abs(tl.duration * 24 - Math.round(tl.duration * 24))).toBeLessThan(1e-6);
      const f = path.join(d, `s${i}.mp4`);
      await renderSceneVideo({ source: { kind: "image", file: still }, timeline: tl, settings: S180, out: f, workDir: d });
      files.push(f); total += tl.duration;
    }
    ff(["-f", "lavfi", "-i", `sine=f=300:d=${total}`, "-ar", "48000", "-ac", "2", path.join(d, "m.wav")]);
    await assembleFinal({ sceneVideos: files, audio: path.join(d, "m.wav"), settings: S180, out: path.join(d, "f.mp4"), workDir: d });
    const v = await validateFinalMp4(path.join(d, "f.mp4"), { width: S180.width, height: S180.height, fps: 24, durationSec: total, durationToleranceSec: 0.05 });
    expect(v.ok).toBe(true);
  });
});

describe("final validation refuses bad media (never reports success falsely)", () => {
  async function good(d: string) {
    const still = makePng(path.join(d, "s.png"), "0x664422", 320, 180);
    const tl = timeline([["Akira", "hi", 1.0]]);
    await renderSceneVideo({ source: { kind: "image", file: still }, timeline: tl, settings: S180, out: path.join(d, "v.mp4"), workDir: d });
    ff(["-f", "lavfi", "-i", `sine=f=300:d=${tl.duration}`, "-ar", "48000", "-ac", "2", path.join(d, "a.wav")]);
    await assembleFinal({ sceneVideos: [path.join(d, "v.mp4")], audio: path.join(d, "a.wav"), settings: S180, out: path.join(d, "good.mp4"), workDir: d });
    return { file: path.join(d, "good.mp4"), tl };
  }
  const exp = { width: S180.width, height: S180.height, fps: 24 };
  it("accepts a good file", async () => { const d = mk(); const g = await good(d); expect((await validateFinalMp4(g.file, { ...exp, durationSec: g.tl.duration })).ok).toBe(true); });
  it("rejects: missing file, no audio stream, wrong resolution, wrong fps, length mismatch, truncated/corrupt data", async () => {
    const d = mk(); const g = await good(d);
    expect((await validateFinalMp4(path.join(d, "nope.mp4"), exp)).ok).toBe(false);
    ff(["-i", path.join(d, "v.mp4"), "-c", "copy", path.join(d, "noaudio.mp4")]);
    expect((await validateFinalMp4(path.join(d, "noaudio.mp4"), exp)).checks.find((c) => c.name === "audio stream")!.ok).toBe(false);
    expect((await validateFinalMp4(g.file, { ...exp, width: 1920, height: 1080 })).checks.find((c) => c.name === "resolution")!.ok).toBe(false);
    expect((await validateFinalMp4(g.file, { ...exp, fps: 30 })).checks.find((c) => c.name === "frame rate")!.ok).toBe(false);
    expect((await validateFinalMp4(g.file, { ...exp, durationSec: 99 })).checks.find((c) => c.name === "length matches timeline")!.ok).toBe(false);
    const buf = fs.readFileSync(g.file); const bad = path.join(d, "trunc.mp4");
    const corrupt = Buffer.from(buf); for (let i = Math.floor(buf.length * 0.6); i < Math.floor(buf.length * 0.6) + 400; i++) corrupt[i] = 0xff;
    fs.writeFileSync(bad, corrupt);
    expect((await validateFinalMp4(bad, exp)).ok).toBe(false);
  });
});

describe("render settings are configurable", () => {
  it("defaults to 1080p at 24 fps for each aspect ratio", () => {
    const e = {} as NodeJS.ProcessEnv;
    expect([resolveRenderSettings("16:9", e).width, resolveRenderSettings("16:9", e).height]).toEqual([1920, 1080]);
    expect([resolveRenderSettings("9:16", e).width, resolveRenderSettings("9:16", e).height]).toEqual([1080, 1920]);
    expect([resolveRenderSettings("1:1", e).width, resolveRenderSettings("1:1", e).height]).toEqual([1080, 1080]);
    expect(resolveRenderSettings("16:9", e).fps).toBe(24);
  });
  it("honours env overrides and rejects an invalid fps", () => {
    const s = resolveRenderSettings("16:9", { RENDER_HEIGHT: "720", RENDER_FPS: "30", RENDER_VIDEO_BITRATE_K: "6000", RENDER_AUDIO_BITRATE_K: "256" } as NodeJS.ProcessEnv);
    expect(s).toMatchObject({ width: 1280, height: 720, fps: 30, videoBitrateK: 6000, audioBitrateK: 256 });
    expect(() => resolveRenderSettings("16:9", { RENDER_FPS: "0" } as NodeJS.ProcessEnv)).toThrow(/RENDER_FPS/);
  });
});
