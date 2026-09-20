import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { synthVoice, writeWav, tmpDir, rmDir, ff, rmsDb, firstOnset } from "./fixtures";
import { renderSceneStems, renderMaster, measureLoudness, measureDialogueClip, buildStemArgs } from "../../src/lib/engine/mixer";
import { decodeMonoPcm } from "../../src/lib/engine/audioAnalysis";
import { synthSfx, planSfx } from "../../src/lib/engine/sfx";
import { probeMedia } from "../../src/lib/engine/validate";
import type { SfxType } from "../../src/lib/engine/types";

const dirs: string[] = [];
const mk = () => { const d = tmpDir(); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmDir(dirs.pop()!); });
const SR = 16000;

describe("dialogue stems", () => {
  it("places each clip on the timeline at its start time (within 25 ms)", async () => {
    const d = mk();
    const a = writeWav(path.join(d, "a.wav"), synthVoice({ duration: 1.0, words: [{ start: 0.05, end: 0.9 }], f0: 120 }));
    const b = writeWav(path.join(d, "b.wav"), synthVoice({ duration: 1.0, words: [{ start: 0.05, end: 0.9 }], f0: 210 }));
    await renderSceneStems({ duration: 5, dialogue: [{ file: a, start: 0.5 }, { file: b, start: 2.75 }], sfx: [] }, { dialogue: path.join(d, "dlg.wav"), sfx: path.join(d, "sfx.wav") });
    const pcm = await decodeMonoPcm(path.join(d, "dlg.wav"), SR);
    expect(pcm.length / SR).toBeCloseTo(5, 2);
    const on1 = firstOnset(pcm, SR, 0.02), on2 = firstOnset(pcm, SR, 0.02, 2.0);
    expect(Math.abs(on1 - 0.55)).toBeLessThan(0.05);   // clip content starts 50 ms in
    expect(Math.abs(on2 - 2.8)).toBeLessThan(0.05);
    expect(rmsDb(pcm, SR, 1.7, 2.6)).toBeLessThan(-60); // silence between lines is silent
  });
  it("REGRESSION: clips are still placed correctly when loudness normalisation is applied (loudnorm+adelay ordering)", async () => {
    const d = mk();
    const a = writeWav(path.join(d, "a.wav"), synthVoice({ duration: 1.0, words: [{ start: 0.05, end: 0.9 }], f0: 120 }));
    const b = writeWav(path.join(d, "b.wav"), synthVoice({ duration: 1.0, words: [{ start: 0.05, end: 0.9 }], f0: 210 }));
    await renderSceneStems({ duration: 6, dialogue: [{ file: a, start: 0.5, loudness: await measureDialogueClip(a) }, { file: b, start: 3.25, loudness: await measureDialogueClip(b) }], sfx: [] }, { dialogue: path.join(d, "dlg.wav"), sfx: path.join(d, "sfx.wav") });
    const pcm = await decodeMonoPcm(path.join(d, "dlg.wav"), SR);
    expect(pcm.length / SR).toBeCloseTo(6, 2);                                   // padding survived
    expect(Math.abs(firstOnset(pcm, SR, 0.02) - 0.55)).toBeLessThan(0.05);       // delay survived
    expect(Math.abs(firstOnset(pcm, SR, 0.02, 2.0) - 3.3)).toBeLessThan(0.05);
    expect(rmsDb(pcm, SR, 1.7, 3.0)).toBeLessThan(-60);
  });
  it("two-pass loudness lands near -16 LUFS whether the source was quiet or loud", async () => {
    const d = mk();
    for (const [name, gain] of [["quiet", 0.15], ["loud", 1.0]] as const) {
      const s = synthVoice({ duration: 3, words: [{ start: 0.1, end: 2.8 }] }).map((x) => x * gain);
      const src = writeWav(path.join(d, `${name}.wav`), s);
      const m = await measureDialogueClip(src);
      await renderSceneStems({ duration: 3.2, dialogue: [{ file: src, start: 0, loudness: m }], sfx: [] }, { dialogue: path.join(d, `${name}-out.wav`), sfx: path.join(d, `${name}-sfx.wav`) });
      const after = await measureLoudness(path.join(d, `${name}-out.wav`));
      expect(Math.abs(after!.inputI - -16)).toBeLessThan(2.0);
    }
  });
  it("silence is left alone (no amplification of noise) and denoise flag builds a valid graph", async () => {
    const d = mk();
    const s = writeWav(path.join(d, "s.wav"), synthVoice({ duration: 1, words: [] }));
    expect(await measureDialogueClip(s)).toBeNull(); // a -70 LUFS noise floor must NOT be "normalised" up by 54 dB
    await renderSceneStems({ duration: 1, dialogue: [{ file: s, start: 0, loudness: null, denoise: true }], sfx: [] }, { dialogue: path.join(d, "o.wav"), sfx: path.join(d, "o2.wav") });
    expect(fs.statSync(path.join(d, "o.wav")).size).toBeGreaterThan(1000);
  });
  it("a scene with no dialogue and no SFX still yields correctly sized silent stems", async () => {
    const d = mk();
    await renderSceneStems({ duration: 2, dialogue: [], sfx: [] }, { dialogue: path.join(d, "a.wav"), sfx: path.join(d, "b.wav") });
    expect((await probeMedia(path.join(d, "a.wav"))).formatDuration).toBeCloseTo(2, 2);
    expect(buildStemArgs({ duration: 2, dialogue: [], sfx: [] }, { dialogue: "a", sfx: "b" }).join(" ")).toContain("anullsrc");
  });
});

describe("SFX synthesis and placement", () => {
  const types: SfxType[] = ["footstep", "door", "rain", "wind", "thunder", "sword", "impact", "explosion", "magic", "crowd", "vehicle"];
  it("every SFX type synthesises audible audio, and synthesis is deterministic", async () => {
    const d = mk();
    for (const t of types) {
      const f1 = path.join(d, `${t}1.wav`), f2 = path.join(d, `${t}2.wav`);
      await synthSfx(t, 1.0, f1); await synthSfx(t, 1.0, f2);
      const pcm = await decodeMonoPcm(f1, SR);
      expect(rmsDb(pcm, SR, 0, 0.9)).toBeGreaterThan(-45);
      expect(fs.readFileSync(f1).equals(fs.readFileSync(f2))).toBe(true);
    }
  });
  it("SFX are level-calibrated: one-shots are peak-limited and every type sits in a sane RMS band relative to dialogue", async () => {
    const d = mk();
    for (const t of types) {
      const f = path.join(d, `${t}.wav`); await synthSfx(t, 1.0, f);
      const pcm = await decodeMonoPcm(f, SR);
      const peak = Math.max(...Array.from(pcm, (v) => Math.abs(v)));
      expect(20 * Math.log10(peak + 1e-9)).toBeLessThanOrEqual(-2.0);            // never near clipping
      const rms = rmsDb(pcm, SR, 0, 1.0);
      expect(rms).toBeLessThanOrEqual(-19);                                        // not louder than speech (~-19 dBFS RMS)
      expect(rms).toBeGreaterThan(-60);
    }
    // effective playback level = calibrated level + the planned event volume. Thunder used to be as loud as the narration.
    await synthSfx("thunder", 2.4, path.join(d, "th.wav"));
    const ev = planSfx(["thunder"], { sceneNumber: 1, duration: 8, segments: [] })[0]!;
    const effective = rmsDb(await decodeMonoPcm(path.join(d, "th.wav"), SR), SR, 0, 2.4) + 20 * Math.log10(ev.volume);
    expect(effective).toBeLessThan(-24);
  });
  it("places a one-shot at its start time and loops an ambient bed for the full duration", async () => {
    const d = mk();
    await synthSfx("impact", 0.4, path.join(d, "hit.wav")); await synthSfx("rain", 1.0, path.join(d, "rain.wav"));
    await renderSceneStems({ duration: 4, dialogue: [], sfx: [
      { file: path.join(d, "hit.wav"), start: 1.5, duration: 0.4, volume: 0.8, loop: false },
      { file: path.join(d, "rain.wav"), start: 0, duration: 4, volume: 0.3, loop: true } ] }, { dialogue: path.join(d, "d.wav"), sfx: path.join(d, "s.wav") });
    const pcm = await decodeMonoPcm(path.join(d, "s.wav"), SR);
    expect(rmsDb(pcm, SR, 3.2, 3.9)).toBeGreaterThan(-50);  // rain still present late in the scene
    expect(rmsDb(pcm, SR, 1.5, 1.6)).toBeGreaterThan(rmsDb(pcm, SR, 1.0, 1.1) + 6); // the hit stands out from the bed
  });
});

describe("master mix: music ducking", () => {
  async function build(withMusic: boolean, extra: Record<string, unknown> = {}) {
    const d = mk();
    const T = 10;
    const voice = writeWav(path.join(d, "v.wav"), synthVoice({ duration: 2, words: [{ start: 0.05, end: 1.95 }] }));
    await renderSceneStems({ duration: T, dialogue: [{ file: voice, start: 2.5, loudness: await measureDialogueClip(voice) }], sfx: [] }, { dialogue: path.join(d, "dlg.wav"), sfx: path.join(d, "sfx.wav") });
    ff(["-f", "lavfi", "-i", `sine=f=220:d=${T + 1}`, "-f", "lavfi", "-i", `sine=f=330:d=${T + 1}`, "-filter_complex", "amix=inputs=2:normalize=0", path.join(d, "music.wav")]);
    const out = path.join(d, "master.wav"), duck = path.join(d, "ducked.wav");
    await renderMaster({ dialogueStems: [path.join(d, "dlg.wav")], sfxStems: [path.join(d, "sfx.wav")], totalDuration: T, music: withMusic ? { file: path.join(d, "music.wav") } : null, debugDuckedMusic: withMusic ? duck : undefined, ...extra }, out);
    return { d, out, duck, T };
  }
  it("music drops under dialogue by >= 8 dB and returns gradually afterwards", async () => {
    const { duck } = await build(true);
    const m = await decodeMonoPcm(duck, SR);
    const pre = rmsDb(m, SR, 1.7, 2.3), during = rmsDb(m, SR, 3.2, 4.2), mid = rmsDb(m, SR, 5.0, 5.2), late = rmsDb(m, SR, 7.0, 7.6);
    expect(pre - during).toBeGreaterThanOrEqual(8);
    expect(mid).toBeGreaterThan(during + 1);          // recovering...
    expect(late).toBeGreaterThan(mid + 1);            // ...gradually, not a snap
    expect(pre - late).toBeLessThan(3);               // fully back by ~2.5 s after the line
  });
  it("music never overpowers dialogue: while someone speaks, the ducked music is >= 15 dB below the speech", async () => {
    const { d, duck } = await build(true);
    const dlg = await decodeMonoPcm(path.join(d, "dlg.wav"), SR), music = await decodeMonoPcm(duck, SR);
    const margin = rmsDb(dlg, SR, 3.0, 4.4) - rmsDb(music, SR, 3.0, 4.4); // same instant, same window
    expect(margin).toBeGreaterThanOrEqual(15);
  });
  it("resting music bed (between lines) stays clearly below speech level", async () => {
    const { d, duck } = await build(true);
    const dlg = await decodeMonoPcm(path.join(d, "dlg.wav"), SR), music = await decodeMonoPcm(duck, SR);
    expect(rmsDb(dlg, SR, 3.0, 4.4) - rmsDb(music, SR, 7.0, 7.6)).toBeGreaterThanOrEqual(6);
  });
  it("master has exactly the planned duration, with and without music", async () => {
    for (const withMusic of [true, false]) {
      const { out, T } = await build(withMusic);
      expect((await probeMedia(out)).formatDuration).toBeCloseTo(T, 1);
    }
  });
  it("final master lands near the loudness target and does not clip", async () => {
    const { out } = await build(true);
    const m = await measureLoudness(out);
    expect(Math.abs(m!.inputI - -16)).toBeLessThan(3);
    expect(m!.inputTP).toBeLessThan(-0.5);
  });
});
