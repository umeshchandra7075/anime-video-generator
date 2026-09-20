import type { SfxEvent, SfxType } from "./types";
import { getBinaries, runProcess } from "./binaries";

const RULES: Array<[SfxType, RegExp]> = [
  ["thunder", /thunder|lightning/i],
  ["explosion", /explos|blast|\bboom\b|bomb/i],
  ["sword", /sword|blade|katana|slash|clang|swords/i],
  ["door", /door|knock/i], // before "impact": "door slams shut" is a door
  ["impact", /punch|\bhit\b|impact|crash|thud|smash|strike|slam/i],
  ["magic", /magic|spell|energy|aura|glow|sparkle|\bpower\b|chant/i],
  ["footstep", /foot|step|walk|boots|stride/i],
  ["rain", /rain|drizzle|downpour/i],
  ["wind", /wind|breeze|gust/i],
  ["crowd", /crowd|chatter|murmur|market|festival/i],
  ["vehicle", /\bcar\b|engine|train|vehicle|motorcycle|\bbus\b|traffic/i],
];
export function classifySfx(hint: string): SfxType | null {
  for (const [type, re] of RULES) if (re.test(hint)) return type;
  return null;
}

const AMBIENT: SfxType[] = ["rain", "wind", "crowd", "vehicle"];
const DEFAULT_DURATION: Record<SfxType, number> = { footstep: 0.18, door: 0.7, rain: 0, wind: 0, thunder: 2.4, sword: 0.6, impact: 0.4, explosion: 1.8, magic: 1.4, crowd: 0, vehicle: 0 };
const BASE_VOLUME: Record<SfxType, number> = { footstep: 0.35, door: 0.6, rain: 0.22, wind: 0.2, thunder: 0.5, sword: 0.5, impact: 0.55, explosion: 0.65, magic: 0.4, crowd: 0.18, vehicle: 0.2 };
const PRIORITY: Record<SfxType, number> = { explosion: 9, impact: 8, sword: 8, thunder: 7, magic: 6, door: 5, footstep: 4, vehicle: 3, rain: 2, wind: 2, crowd: 1 };

export interface SfxPlanContext { sceneNumber: number; duration: number; segments: Array<{ start: number; end: number }> }

/** Silent stretches (>= minLen) between/around dialogue windows. */
export function dialogueGaps(duration: number, segments: Array<{ start: number; end: number }>, minLen = 0.2): Array<{ start: number; end: number }> {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const gaps: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const s of sorted) { if (s.start - cursor >= minLen) gaps.push({ start: cursor, end: s.start }); cursor = Math.max(cursor, s.end); }
  if (duration - cursor >= minLen) gaps.push({ start: cursor, end: duration });
  return gaps;
}

/** Deterministic placement on the scene timeline. Ambient beds loop for the whole scene; one-shots start
 * at fixed anchors, but an anchor that would put the ONSET on top of a spoken line is moved to the nearest
 * dialogue gap (a door slam or thunder crack must not mask the first word of a line). If no gap exists the
 * one-shot keeps its anchor and is attenuated instead. Footsteps repeat. */
export function planSfx(hints: string[], ctx: SfxPlanContext): SfxEvent[] {
  const D = ctx.duration;
  const events: SfxEvent[] = [];
  const seen = new Set<SfxType>();
  const anchors = [0.3, 0.35 * D, 0.65 * D, 0.85 * D];
  const gaps = dialogueGaps(D, ctx.segments);
  let anchorIdx = 0, n = 0;
  const overDialogue = (t0: number, t1: number) => ctx.segments.some((s) => t0 < s.end && t1 > s.start);
  const id = () => `sfx_${String(ctx.sceneNumber).padStart(3, "0")}_${String(++n).padStart(2, "0")}`;
  const inGap = (t: number) => gaps.some((g) => t >= g.start && t < g.end - 0.05);
  const usedOnsets: number[] = [];
  const clash = (t: number) => usedOnsets.some((u) => Math.abs(u - t) < 0.4); // do not stack two impacts on one instant
  const placeOnset = (anchor: number, dur: number): number => {
    let start = anchor;
    if (!inGap(anchor) && gaps.length > 0) {
      const cands = gaps.map((g) => Math.min(Math.max(anchor, g.start), Math.max(g.start, g.end - Math.min(0.15, dur))));
      const free = cands.filter((c) => !clash(c));
      const pool = free.length > 0 ? free : cands;
      start = pool.reduce((b, c) => (Math.abs(c - anchor) < Math.abs(b - anchor) ? c : b), pool[0]!);
    } else if (clash(anchor)) {
      const alt = anchors.find((a) => !clash(a) && (gaps.length === 0 || inGap(a)));
      if (alt !== undefined) start = alt;
    }
    const placed = Math.round(Math.min(start, Math.max(0, D - dur)) * 1000) / 1000;
    usedOnsets.push(placed);
    return placed;
  };

  for (const hint of hints) {
    const type = classifySfx(hint);
    if (!type || seen.has(type)) continue;
    seen.add(type);
    if (AMBIENT.includes(type)) {
      events.push({ sfxId: id(), type, startTime: 0, duration: D, volume: BASE_VOLUME[type], source: "procedural", ref: hint, priority: PRIORITY[type], loop: true });
      continue;
    }
    if (type === "footstep") {
      const count = Math.max(2, Math.min(8, Math.floor(D / 0.6)));
      for (let k = 0; k < count; k++) {
        const t = 0.4 + k * 0.55;
        if (t + 0.18 > D) break;
        events.push({ sfxId: id(), type, startTime: Math.round(t * 1000) / 1000, duration: 0.18, volume: BASE_VOLUME.footstep * (overDialogue(t, t + 0.18) ? 0.5 : 1), source: "procedural", ref: hint, priority: PRIORITY.footstep, loop: false });
      }
      continue;
    }
    const dur = Math.min(DEFAULT_DURATION[type], D);
    const start = placeOnset(anchors[anchorIdx % anchors.length]!, dur);
    anchorIdx++;
    events.push({ sfxId: id(), type, startTime: start, duration: dur, volume: BASE_VOLUME[type] * (overDialogue(start, start + dur) ? 0.5 : 1), source: "procedural", ref: hint, priority: PRIORITY[type], loop: false });
  }
  return events;
}

// ---- procedural synthesis (deterministic hash-noise, so files are repeatable) ----
const NOISE = "mod(sin(n*12.9898)*43758.5453,1)";
function shot(expr: string, dur: number): string[] {
  return ["-f", "lavfi", "-i", `aevalsrc='${expr}':d=${dur}:s=48000`];
}
export function synthSfxArgs(type: SfxType, dur: number, out: string): string[] {
  const d = Math.max(0.1, dur);
  let input: string[]; let af = "";
  switch (type) {
    case "footstep": input = shot(`sin(2*PI*85*t)*exp(-t*30)*0.8+${NOISE}*exp(-t*60)*0.35`, d); break;
    case "door": input = shot(`sin(2*PI*55*t)*exp(-t*9)*0.9+${NOISE}*exp(-t*35)*0.45`, d); break;
    case "impact": input = shot(`sin(2*PI*70*t)*exp(-t*14)*0.9+${NOISE}*exp(-t*50)*0.55`, d); break;
    case "sword": input = shot(`(sin(2*PI*2200*t)+0.6*sin(2*PI*3300*t)+0.4*sin(2*PI*5100*t))*exp(-t*9)*0.3+${NOISE}*exp(-t*40)*0.45`, d); break;
    case "explosion": input = shot(`${NOISE}*exp(-t*2.2)*0.9+sin(2*PI*45*t)*exp(-t*3)*0.7`, d); af = "lowpass=f=1400"; break;
    case "magic": input = shot(`sin(2*PI*(600+800*t)*t)*0.25*(1-exp(-t*30))*exp(-t*1.6)+sin(2*PI*(1200+1600*t)*t)*0.12*exp(-t*2)`, d); break;
    case "thunder": input = shot(`${NOISE}*(1-exp(-t*40))*exp(-t*1.4)`, d); af = "lowpass=f=170"; break;
    case "rain": input = shot(NOISE, d); af = "highpass=f=900,lowpass=f=9000"; break;
    case "wind": input = shot(NOISE, d); af = "lowpass=f=700,highpass=f=120,tremolo=f=0.4:d=0.6"; break;
    case "crowd": input = shot(NOISE, d); af = "bandpass=f=500:width_type=h:w=800,tremolo=f=4:d=0.5"; break;
    case "vehicle": input = shot(`${NOISE}*0.5+sin(2*PI*58*t)*0.4`, d); af = "lowpass=f=320"; break;
  }
  return ["-y", "-v", "error", ...input, ...(af ? ["-af", af] : []), "-t", String(d), "-ar", "48000", "-ac", "1", out];
}
/** Reference levels so that an event's `volume` is meaningful RELATIVE to dialogue (speech sits near -19 dBFS RMS
 * after normalisation). Impulsive one-shots are peak-limited, ambient beds sit well underneath. */
export const SFX_TARGET_RMS_DB: Record<"oneshot" | "ambient", number> = { oneshot: -20, ambient: -32 };
const SFX_PEAK_CEIL_DB = -3;

async function measureLevels(file: string): Promise<{ mean: number; max: number } | null> {
  const { stderr } = await runProcess(getBinaries().ffmpeg, ["-hide_banner", "-nostats", "-i", file, "-af", "volumedetect", "-f", "null", "-"], { timeoutMs: 60_000 });
  const mean = stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/), max = stderr.match(/max_volume:\s*(-?[\d.]+)\s*dB/);
  return mean && max ? { mean: Number(mean[1]), max: Number(max[1]) } : null;
}

/** Synthesises the effect, then applies ONE gain so its RMS hits the class target without the peak exceeding -3 dBFS. */
export async function synthSfx(type: SfxType, dur: number, out: string): Promise<{ appliedGainDb: number }> {
  const raw = `${out}.raw.wav`;
  await runProcess(getBinaries().ffmpeg, synthSfxArgs(type, dur, raw), { timeoutMs: 60_000 });
  try {
    const lv = await measureLevels(raw);
    const target = SFX_TARGET_RMS_DB[AMBIENT.includes(type) ? "ambient" : "oneshot"];
    const gain = lv && Number.isFinite(lv.mean) ? Math.min(target - lv.mean, SFX_PEAK_CEIL_DB - lv.max) : 0;
    await runProcess(getBinaries().ffmpeg, ["-y", "-v", "error", "-i", raw, "-af", `volume=${gain.toFixed(3)}dB`, "-c:a", "pcm_s16le", out], { timeoutMs: 60_000 });
    return { appliedGainDb: gain };
  } finally { await import("node:fs/promises").then((f) => f.rm(raw, { force: true })); }
}
