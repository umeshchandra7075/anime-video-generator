// Audio: per-scene dialogue + SFX stems, then one project master where music
// is ducked by a sidechain keyed on the dialogue bus. All gain staging is
// explicit: dialogue is loudness-normalised (-16 LUFS by default, two-pass),
// music sits at MUSIC_LUFS between lines and is pushed down under speech.
import { getBinaries, runProcess } from "./binaries";

export const SAMPLE_RATE = 48000;
const FMT = `aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=stereo`;
const n3 = (x: number) => Number(x.toFixed(6)).toString(); // microsecond precision: frame-snapped durations stay exact

export interface LoudnessMeasure { inputI: number; inputTP: number; inputLRA: number; inputThresh: number; targetOffset: number }

/** Below this integrated loudness a clip is treated as silence: normalising it would
 * amplify a noise floor by 50+ dB. */
export const SILENCE_FLOOR_LUFS = -50;

/** First pass of two-pass loudnorm. `preFilters` MUST be the exact filters that run before
 * loudnorm in the real chain, otherwise the measured parameters describe a different signal.
 * Returns null for silence / unmeasurable audio. */
export async function measureLoudness(file: string, target = { I: -16, TP: -1.5, LRA: 11 }, preFilters: string[] = []): Promise<LoudnessMeasure | null> {
  const af = [...preFilters, `loudnorm=I=${target.I}:TP=${target.TP}:LRA=${target.LRA}:print_format=json`].join(",");
  const { stderr } = await runProcess(getBinaries().ffmpeg, ["-hide_banner", "-nostats", "-i", file, "-af", af, "-f", "null", "-"], { timeoutMs: 120_000 });
  const m = stderr.match(/\{[\s\S]*?"target_offset"[\s\S]*?\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as Record<string, string>;
    const num = (k: string) => Number(j[k]);
    const r = { inputI: num("input_i"), inputTP: num("input_tp"), inputLRA: num("input_lra"), inputThresh: num("input_thresh"), targetOffset: num("target_offset") };
    if (!Object.values(r).every(Number.isFinite) || r.inputI < SILENCE_FLOOR_LUFS) return null;
    return r;
  } catch { return null; }
}

function loudnormFilter(m: LoudnessMeasure | null, t: { I: number; TP: number; LRA: number }): string {
  if (!m) return ""; // silent/unmeasurable: leave untouched rather than amplify noise
  return `loudnorm=I=${t.I}:TP=${t.TP}:LRA=${t.LRA}:measured_I=${m.inputI}:measured_TP=${m.inputTP}:measured_LRA=${m.inputLRA}:measured_thresh=${m.inputThresh}:offset=${m.targetOffset}:linear=true:print_format=none`;
}

export interface DialogueClip { file: string; start: number; loudness?: LoudnessMeasure | null; denoise?: boolean }
export interface SfxClip { file: string; start: number; duration: number; volume: number; loop: boolean }
export interface StemPlan { duration: number; dialogue: DialogueClip[]; sfx: SfxClip[]; dialogueTarget?: { I: number; TP: number; LRA: number } }

/** Everything that runs BEFORE loudness normalisation on a dialogue clip. Shared by the
 * measurement pass and the render pass so both see the same signal. */
export function dialoguePreFilters(c: { denoise?: boolean }): string[] {
  return [FMT, ...(c.denoise ? ["afftdn=nr=12:nf=-45"] : []), "highpass=f=80", "acompressor=threshold=0.125:ratio=3:attack=5:release=80:makeup=1", "equalizer=f=3000:t=q:w=1:g=2"];
}

/** Measures a dialogue clip AS IT WILL BE PROCESSED (compressor/EQ included). */
export function measureDialogueClip(file: string, opts: { denoise?: boolean } = {}, target = { I: -16, TP: -1.5, LRA: 11 }): Promise<LoudnessMeasure | null> {
  return measureLoudness(file, target, dialoguePreFilters(opts));
}

/** Dialogue chain: format -> (optional denoise) -> high-pass -> gentle compression -> presence EQ ->
 * two-pass loudness -> placement on the timeline. */
export function dialogueChain(idx: number, c: DialogueClip, target: { I: number; TP: number; LRA: number }): string {
  const ms = Math.max(0, Math.round(c.start * 1000));
  // ORDER MATTERS (verified on FFmpeg 6.1): adelay must come BEFORE loudnorm. loudnorm emits 192 kHz
  // frames and a following adelay/apad silently loses the delay and the padding. Linear two-pass
  // loudnorm is a pure gain and the loudness gate ignores leading silence, so measuring the undelayed
  // clip stays valid. aresample brings the rate back to 48 kHz for mixing.
  const ln = loudnormFilter(c.loudness ?? null, target);
  const parts = [...dialoguePreFilters(c), `adelay=${ms}|${ms}`, ...(ln ? [ln, `aresample=${SAMPLE_RATE}`] : [])];
  return `[${idx}:a]${parts.join(",")}[d${idx}]`;
}

export function buildStemArgs(plan: StemPlan, out: { dialogue: string; sfx: string }): string[] {
  const D = plan.duration;
  const target = plan.dialogueTarget ?? { I: -16, TP: -1.5, LRA: 11 };
  const args: string[] = ["-y", "-v", "error"];
  const chains: string[] = [];
  plan.dialogue.forEach((c) => args.push("-i", c.file));
  plan.sfx.forEach((c) => args.push("-i", c.file));
  const dN = plan.dialogue.length;
  plan.dialogue.forEach((c, i) => chains.push(dialogueChain(i, c, target)));
  const pad = `apad=whole_dur=${n3(D)},atrim=0:${n3(D)}`;
  chains.push(dN > 0
    ? `${plan.dialogue.map((_, i) => `[d${i}]`).join("")}amix=inputs=${dN}:normalize=0:duration=longest,${pad}[dlg]`
    : `anullsrc=r=${SAMPLE_RATE}:cl=stereo,atrim=0:${n3(D)}[dlg]`);
  plan.sfx.forEach((c, j) => {
    const idx = dN + j, ms = Math.round(c.start * 1000), dur = Math.max(0.05, c.duration);
    const shape = c.loop ? `aloop=loop=-1:size=2000000000,atrim=0:${n3(dur)}` : `atrim=0:${n3(dur)}`;
    const fadeOut = Math.min(0.06, dur / 2);
    chains.push(`[${idx}:a]${FMT},${shape},volume=${n3(c.volume)},afade=t=in:d=0.01,afade=t=out:st=${n3(Math.max(0, dur - fadeOut))}:d=${n3(fadeOut)},adelay=${ms}|${ms}[x${j}]`);
  });
  const sN = plan.sfx.length;
  chains.push(sN > 0
    ? `${plan.sfx.map((_, j) => `[x${j}]`).join("")}amix=inputs=${sN}:normalize=0:duration=longest,${pad}[sfx]`
    : `anullsrc=r=${SAMPLE_RATE}:cl=stereo,atrim=0:${n3(D)}[sfx]`);
  args.push("-filter_complex", chains.join(";"), "-map", "[dlg]", "-c:a", "pcm_s16le", out.dialogue, "-map", "[sfx]", "-c:a", "pcm_s16le", out.sfx);
  return args;
}

export async function renderSceneStems(plan: StemPlan, out: { dialogue: string; sfx: string }): Promise<void> {
  await runProcess(getBinaries().ffmpeg, buildStemArgs(plan, out), { timeoutMs: 5 * 60_000 });
}

export interface MasterPlan {
  dialogueStems: string[]; // per scene, in order
  sfxStems: string[];
  totalDuration: number;
  music?: { file: string; loudness?: LoudnessMeasure | null; lufs?: number; fadeInSec?: number; fadeOutSec?: number } | null;
  duck?: { threshold?: number; ratio?: number; attackMs?: number; releaseMs?: number };
  masterLufs?: number;
  /** write the ducked music stem too (tests / Lip-sync & mix inspection) */
  debugDuckedMusic?: string;
}

export function buildMasterArgs(plan: MasterPlan, out: string): string[] {
  const T = plan.totalDuration;
  const args: string[] = ["-y", "-v", "error"];
  [...plan.dialogueStems, ...plan.sfxStems].forEach((f) => args.push("-i", f));
  const nD = plan.dialogueStems.length, nS = plan.sfxStems.length;
  const ch: string[] = [];
  ch.push(`${plan.dialogueStems.map((_, i) => `[${i}:a]`).join("")}concat=n=${nD}:v=0:a=1[dlgcat]`);
  ch.push(`${plan.sfxStems.map((_, i) => `[${nD + i}:a]`).join("")}concat=n=${nS}:v=0:a=1[sfx]`);
  const hasMusic = !!plan.music;
  const tail = `alimiter=limit=0.95,aresample=${SAMPLE_RATE},atrim=0:${n3(T)},apad=whole_dur=${n3(T)}`; // master loudness is a separate measured two-pass step (finalizeMaster)
  // Dialogue has priority over BOTH music and SFX: each is sidechain-compressed by the dialogue bus.
  const sfxDuck = (key: string) => `[sfx][${key}]sidechaincompress=threshold=0.03:ratio=3:attack=20:release=300:makeup=1[sfxd]`;
  if (hasMusic) {
    const m = plan.music!;
    args.push("-stream_loop", "-1", "-i", m.file);
    const mIdx = nD + nS;
    const fin = m.fadeInSec ?? 1.5, fout = Math.min(m.fadeOutSec ?? 2, T / 2);
    const lufs = m.lufs ?? -26;
    const norm = m.loudness ? loudnormFilter(m.loudness, { I: lufs, TP: -3, LRA: 11 }) : m.loudness === null ? "volume=1" : `loudnorm=I=${lufs}:TP=-3:LRA=11`;
    ch.push(`[${mIdx}:a]${FMT},atrim=0:${n3(T)},${norm},aresample=${SAMPLE_RATE},afade=t=in:d=${n3(fin)},afade=t=out:st=${n3(Math.max(0, T - fout))}:d=${n3(fout)}[mus]`);
    ch.push(`[dlgcat]asplit=3[dlg][key][key2]`);
    const d = plan.duck ?? {};
    ch.push(`[mus][key]sidechaincompress=threshold=${d.threshold ?? 0.02}:ratio=${d.ratio ?? 8}:attack=${d.attackMs ?? 30}:release=${d.releaseMs ?? 800}:makeup=1[musd]`);
    ch.push(sfxDuck("key2"));
    if (plan.debugDuckedMusic) {
      ch.push(`[musd]asplit=2[musd1][musd2]`);
      ch.push(`[dlg][sfxd][musd1]amix=inputs=3:normalize=0:duration=longest,${tail}[mix]`);
      args.push("-filter_complex", ch.join(";"), "-map", "[mix]", "-c:a", "pcm_s16le", out, "-map", "[musd2]", "-c:a", "pcm_s16le", plan.debugDuckedMusic);
      return args;
    }
    ch.push(`[dlg][sfxd][musd]amix=inputs=3:normalize=0:duration=longest,${tail}[mix]`);
  } else {
    ch.push(`[dlgcat]asplit=2[dlg][key]`);
    ch.push(sfxDuck("key"));
    ch.push(`[dlg][sfxd]amix=inputs=2:normalize=0:duration=longest,${tail}[mix]`);
  }
  args.push("-filter_complex", ch.join(";"), "-map", "[mix]", "-c:a", "pcm_s16le", out);
  return args;
}

/** Pass 2 of the master: measure the summed mix, then apply ONE linear gain to hit the target. */
export async function finalizeMaster(pre: string, out: string, totalDuration: number, targetLufs: number): Promise<{ measuredI: number | null }> {
  const target = { I: targetLufs, TP: -1.5, LRA: 11 };
  const m = await measureLoudness(pre, target);
  const T = n3(totalDuration);
  const af = [...(m ? [loudnormFilter(m, target)] : []), `aresample=${SAMPLE_RATE}`, `atrim=0:${T}`, `apad=whole_dur=${T}`].join(",");
  await runProcess(getBinaries().ffmpeg, ["-y", "-v", "error", "-i", pre, "-af", af, "-c:a", "pcm_s16le", out], { timeoutMs: 10 * 60_000 });
  return { measuredI: m?.inputI ?? null };
}

export async function renderMaster(plan: MasterPlan, out: string): Promise<{ measuredPreMasterLufs: number | null }> {
  let p = plan;
  if (plan.music && plan.music.loudness === undefined) {
    // Single-pass loudnorm adapts its gain over the first seconds, which would fight the ducking.
    // Always use a measured, linear two-pass gain for the music bed.
    const lufs = plan.music.lufs ?? -26;
    const loudness = await measureLoudness(plan.music.file, { I: lufs, TP: -3, LRA: 11 }, [FMT]);
    p = { ...plan, music: { ...plan.music, loudness } };
  }
  const pre = `${out}.premaster.wav`;
  await runProcess(getBinaries().ffmpeg, buildMasterArgs(p, pre), { timeoutMs: 10 * 60_000 });
  try {
    const r = await finalizeMaster(pre, out, plan.totalDuration, plan.masterLufs ?? -16);
    return { measuredPreMasterLufs: r.measuredI };
  } finally {
    await import("node:fs/promises").then((fs) => fs.rm(pre, { force: true }));
  }
}
