import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { compositeFinalVideo } from "../../src/lib/pipeline/compositeStage";
import type { CompositeDeps } from "../../src/lib/pipeline/compositeStage";
import { renderProject, RenderValidationError } from "../../src/lib/engine/projectRender";
import { buildSceneTimeline } from "../../src/lib/engine/timeline";
import { planDialogueSegments } from "../../src/lib/engine/dialogue";
import { synthVoice, writeWav, tmpDir, rmDir, ff, makePng } from "./fixtures";
import { validateFinalMp4 } from "../../src/lib/engine/validate";

const dirs: string[] = []; const mk = () => { const d = tmpDir(); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmDir(dirs.pop()!); });
const ENV = { RENDER_HEIGHT: "240", RENDER_FPS: "24", RENDER_PRESET: "ultrafast", RENDER_SUPERSAMPLE: "1" } as NodeJS.ProcessEnv;
const CH = [{ id: "akira", name: "Akira", voice: { provider: "x", voiceId: "a" } }, { id: "mika", name: "Mika", voice: { provider: "x", voiceId: "m" } }];

function project(opts: { rig?: boolean; music?: boolean; noAudioFor?: string; noTimelineFor?: number } = {}) {
  const d = mk(); const blobs = new Map<string, Buffer>(); const uploads = new Map<string, Buffer>();
  const scenes: any[] = []; const assets: Record<string, any[]> = {}; const characters: any[] = [];
  const png = (n: string, color: string, w: number, h: number) => { const f = makePng(path.join(d, n), color, w, h); return fs.readFileSync(f); };
  for (const n of [1, 2]) {
    const lines: Array<[string, string]> = n === 1 ? [["Akira", "Hello there."], ["Mika", "Hi Akira."]] : [["Mika", "See you soon."]];
    const { segments } = planDialogueSegments({ sceneNumber: n, characters: CH, dialogue: lines.map(([character, line]) => ({ character, line })) });
    const segAudio = segments.map((s) => { const f = writeWav(path.join(d, `${s.segmentId}.wav`), synthVoice({ duration: 1.3, words: [{ start: 0.05, end: 1.2 }] })); blobs.set(`dlg/${s.segmentId}.wav`, fs.readFileSync(f)); return { s, dur: 1.3 }; });
    const tl = buildSceneTimeline({ sceneId: `sc${n}`, sceneNumber: n, fps: 24, language: "en", onScreen: ["akira", "mika"], sceneText: "talk", sfxHints: n === 1 ? ["door"] : [], musicMood: null, isFirstScene: n === 1, isLastScene: n === 2, plannedSeconds: 3,
      segments: segAudio.map(({ s, dur }) => ({ planned: s, audio: { storageKey: `dlg/${s.segmentId}.wav`, mimeType: "audio/wav", durationSeconds: dur, cacheKey: s.segmentId, speechRegions: [{ start: 0.05, end: 1.25 }] } })) });
    blobs.set(`img/${n}.png`, png(`bg${n}.png`, n === 1 ? "0x335577" : "0x775533", 640, 360));
    scenes.push({ id: `sc${n}`, sceneNumber: n, timeline: opts.noTimelineFor === n ? null : JSON.stringify(tl) });
    assets[`sc${n}`] = [{ type: "IMAGE", storageKey: `img/${n}.png`, providerMetadata: null },
      ...tl.segments.filter((s) => s.segmentId !== opts.noAudioFor).map((s) => ({ type: "DIALOGUE_AUDIO", storageKey: s.audio.storageKey, providerMetadata: JSON.stringify({ segmentId: s.segmentId }) }))];
  }
  if (opts.rig) {
    const visemes = ["REST", "AA", "EE", "MBP", "OO", "EH"]; const mouth: Record<string, string> = {};
    visemes.forEach((v, i) => { blobs.set(`rig/m-${v}.png`, png(`m${v}.png`, ["0x202020", "0xff0000", "0x00ff00", "0xffff00", "0x00ffff", "0xff00ff"][i]!, 40, 20)); mouth[v] = `rig/m-${v}.png`; });
    blobs.set("rig/head.png", png("head.png", "0x3050ff", 80, 90));
    characters.push({ id: "akira", providerMetadata: JSON.stringify({ rig: { mouth: { rect: { x: 0.2, y: 0.55, w: 0.1, h: 0.08 }, sprites: mouth }, head: { file: "rig/head.png", x: 0.15, y: 0.25, w: 0.2, h: 0.4 } } }) }, { id: "mika", providerMetadata: null });
  }
  if (opts.music) { ff(["-f", "lavfi", "-i", "sine=f=300:d=30", "-ar", "48000", path.join(d, "music.wav")]); blobs.set("music/m.wav", fs.readFileSync(path.join(d, "music.wav"))); }
  const tmpRoot = mk();
  const deps: CompositeDeps = {
    db: { sceneAsset: { async findMany({ where }: any) { return assets[where.sceneId] ?? []; } }, audioAsset: { async findFirst() { return opts.music ? { storageKey: "music/m.wav" } : null; } }, character: { async findMany() { return characters; } } },
    store: { async get(k) { const b = blobs.get(k); if (!b) throw new Error("missing blob " + k); return b; }, async put(k, data) { uploads.set(k, data); }, key: (pid, ...p) => `projects/${pid}/${p.join("/")}` },
    render: renderProject, env: ENV, tmpRoot,
  };
  return { deps, scenes, uploads, tmpRoot };
}

describe("compositeFinalVideo (real renderer + ffmpeg, fake storage)", () => {
  it("renders a valid final MP4 from the master timelines, uploads it, reports real progress, and cleans its temp dir", async () => {
    const p = project({ music: true }); const prog: number[] = [];
    const r = await compositeFinalVideo("p1", p.scenes, "en", { deps: p.deps, aspectRatio: "16:9", onProgress: (f) => { prog.push(f); } });
    expect(r.storageKey).toBe("projects/p1/final-videos/output.mp4");
    const out = p.uploads.get(r.storageKey)!; expect(out.length).toBe(r.fileSizeBytes);
    const f = path.join(mk(), "out.mp4"); fs.writeFileSync(f, out);
    const v = await validateFinalMp4(f, { width: r.settings.width, height: r.settings.height, fps: 24, durationSec: p.scenes.reduce((s, x) => s + JSON.parse(x.timeline).duration, 0), durationToleranceSec: 0.15 });
    expect(v.checks.filter((c) => !c.ok)).toEqual([]);
    expect(Math.abs(r.durationSeconds - v.info!.durationSec)).toBeLessThan(0.01);
    expect(prog[prog.length - 1]).toBe(1); for (let i = 1; i < prog.length; i++) expect(prog[i]!).toBeGreaterThanOrEqual(prog[i - 1]!);
    expect(fs.readdirSync(p.tmpRoot).filter((n) => n.startsWith("avg-render-"))).toEqual([]);   // no abandoned render files
    expect(r.report).toHaveLength(2);
  });
  it("output resolution follows the project's aspect ratio (9:16 -> portrait)", async () => {
    const p = project(); const r = await compositeFinalVideo("p1", p.scenes, undefined, { deps: p.deps, aspectRatio: "9:16" });
    expect(r.settings.height).toBeGreaterThan(r.settings.width);
  });
  it("uses layered rigs from Character.providerMetadata when present (mouth sprites get composited)", async () => {
    const p = project({ rig: true }); const r = await compositeFinalVideo("p1", p.scenes, undefined, { deps: p.deps });
    expect(r.report.some((s) => s.puppeted)).toBe(true);
  });
  it("FAILS (does not fake success) when a scene has no timeline", async () => {
    const p = project({ noTimelineFor: 2 });
    await expect(compositeFinalVideo("p1", p.scenes, undefined, { deps: p.deps })).rejects.toThrow(/Scene 2 has no master timeline/);
    expect(p.uploads.size).toBe(0); expect(fs.readdirSync(p.tmpRoot)).toEqual([]);
  });
  it("FAILS with a regenerate-the-voice hint when a dialogue audio asset is missing", async () => {
    const p = project({ noAudioFor: "dlg_001_002" });
    await expect(compositeFinalVideo("p1", p.scenes, undefined, { deps: p.deps })).rejects.toThrow(/dlg_001_002 is missing - regenerate the voice/);
    expect(p.uploads.size).toBe(0);
  });
  it("a render that fails validation makes the whole call FAIL and uploads nothing", async () => {
    const p = project(); const bad: CompositeDeps = { ...p.deps, render: async (o) => { fs.writeFileSync(o.outFile, Buffer.from("not a video")); throw new RenderValidationError({ ok: false, checks: [{ name: "ffprobe readable", ok: false, detail: "corrupt" }], info: null }); } };
    await expect(compositeFinalVideo("p1", p.scenes, undefined, { deps: bad })).rejects.toThrow(/failed validation/);
    expect(p.uploads.size).toBe(0); expect(fs.readdirSync(p.tmpRoot)).toEqual([]);
  });
});
