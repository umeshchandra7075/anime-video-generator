// Builds a viseme timeline for one dialogue segment from (a) the text and
// (b) the MEASURED audio. Three timing sources, best first:
//   "provider-alignment"  character timestamps returned by the TTS provider
//   "audio-aligned"       text units time-warped onto measured speech regions
//                         (pauses in the audio snap word boundaries)
//   "energy-only"         syllable nuclei from the amplitude envelope, used
//                         when the language has no grapheme rules
// In every mode, mouth = REST wherever the audio is silent.
import type { CharAlignment, Viseme, VisemeInterval, VisemeQuality, VisemeTrack } from "./types";
import type { Envelope, Region } from "./audioAnalysis";
import { textToWordUnits } from "./g2p";
import type { PhonUnit, WordUnits } from "./g2p";

export interface VisemeInput {
  segmentId: string;
  characterId: string;
  text: string;
  language: string;
  segmentStart: number; // scene-absolute seconds
  duration: number; // measured audio duration
  speechRegions: Region[]; // measured, relative to the segment audio
  envelope?: Envelope;
  alignment?: CharAlignment | null;
  fps: number;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

function alignmentUsable(text: string, al: CharAlignment | null | undefined): al is CharAlignment {
  if (!al || al.characters.length === 0) return false;
  if (al.characters.length !== al.startTimes.length || al.characters.length !== al.endTimes.length) return false;
  if (al.characters.join("") !== text) return false; // offsets would not line up: refuse rather than guess
  for (let i = 0; i < al.startTimes.length; i++) {
    if (!(al.endTimes[i]! >= al.startTimes[i]!) || al.startTimes[i]! < 0) return false;
    if (i > 0 && al.startTimes[i]! + 1e-6 < al.startTimes[i - 1]!) return false;
  }
  return true;
}

function distribute(units: PhonUnit[], t0: number, t1: number): VisemeInterval[] {
  const total = units.reduce((s, u) => s + u.weight, 0);
  if (total <= 0 || t1 <= t0) return [];
  const out: VisemeInterval[] = [];
  let acc = t0;
  for (const u of units) {
    const len = ((t1 - t0) * u.weight) / total;
    if (len > 0) out.push({ start: acc, end: acc + len, viseme: u.viseme });
    acc += len;
  }
  return out;
}

function fromAlignment(words: WordUnits[], al: CharAlignment): VisemeInterval[] {
  const out: VisemeInterval[] = [];
  for (const w of words) {
    const first = w.charStart, last = w.charEnd - 1;
    const t0 = al.startTimes[first], t1 = al.endTimes[last];
    if (t0 === undefined || t1 === undefined) continue;
    out.push(...distribute(w.units, t0, t1));
  }
  return out;
}

function fromAudioAlignment(words: WordUnits[], regions: Region[]): VisemeInterval[] {
  if (words.length === 0 || regions.length === 0) return [];
  const lens = regions.map((r) => r.end - r.start);
  const cumStart: number[] = [];
  let ts = 0;
  for (const l of lens) { cumStart.push(ts); ts += l; }
  if (ts <= 0) return [];

  const wordWeights = words.map((w) => w.units.reduce((s, u) => s + u.weight, 0));
  const totalW = wordWeights.reduce((s, x) => s + x, 0);
  // predicted boundary (in concatenated speech time) after each word
  const bounds: number[] = [];
  let cw = 0;
  for (let i = 0; i < words.length; i++) { cw += wordWeights[i]!; bounds.push((ts * cw) / totalW); }
  bounds[bounds.length - 1] = ts;

  // Snap word boundaries onto real pauses (region gaps). A greedy nearest-gap
  // choice can grab the wrong pause and push later words out of order, so
  // solve it as a monotone assignment minimising total snap distance; a
  // boundary may stay unsnapped at a fixed cost.
  const gaps = cumStart.slice(1); // concatenated-time positions where a pause occurred
  const tol = 0.15;
  const B = bounds.length - 1, G = gaps.length;
  if (B > 0 && G > 0) {
    // best[i][j]: min cost for boundaries 0..i-1 with the last used gap index < j (j in 0..G)
    const INF = 1e9;
    const best: number[][] = Array.from({ length: B + 1 }, () => new Array<number>(G + 1).fill(INF));
    const choice: number[][] = Array.from({ length: B + 1 }, () => new Array<number>(G + 1).fill(-2));
    for (let j = 0; j <= G; j++) best[0]![j] = 0;
    for (let i = 1; i <= B; i++) {
      for (let j = 0; j <= G; j++) {
        // option 1: boundary i-1 unsnapped
        let c = best[i - 1]![j]! + tol, ch = -1;
        // option 2: boundary i-1 snapped to gap k < j
        for (let k = 0; k < j; k++) {
          const d = Math.abs(gaps[k]! - bounds[i - 1]!);
          if (d <= tol * 1.5 && best[i - 1]![k]! + d < c) { c = best[i - 1]![k]! + d; ch = k; }
        }
        best[i]![j] = c; choice[i]![j] = ch;
      }
    }
    // backtrack from (B, G)
    let j = G;
    for (let i = B; i >= 1; i--) {
      const k = choice[i]![j]!;
      if (k >= 0) { bounds[i - 1] = gaps[k]!; j = k; }
    }
  }
  for (let i = 1; i < bounds.length; i++) if (bounds[i]! < bounds[i - 1]!) bounds[i] = bounds[i - 1]!;

  const toReal = (c0: number, c1: number, viseme: Viseme): VisemeInterval[] => {
    const pieces: VisemeInterval[] = [];
    regions.forEach((r, k) => {
      const a = Math.max(c0, cumStart[k]!), b = Math.min(c1, cumStart[k]! + lens[k]!);
      if (b > a) pieces.push({ start: r.start + (a - cumStart[k]!), end: r.start + (b - cumStart[k]!), viseme });
    });
    return pieces;
  };

  const out: VisemeInterval[] = [];
  let prev = 0;
  words.forEach((w, i) => {
    const cw0 = prev, cw1 = bounds[i]!;
    for (const seg of distribute(w.units, cw0, cw1)) out.push(...toReal(seg.start, seg.end, seg.viseme));
    prev = cw1;
  });
  return out;
}

function fromEnergy(env: Envelope, regions: Region[]): VisemeInterval[] {
  const out: VisemeInterval[] = [];
  const v = env.values, hop = env.hopSec;
  const smooth = (i: number) => { let s = 0, n = 0; for (let k = -2; k <= 2; k++) { const x = v[i + k]; if (x !== undefined) { s += x; n++; } } return n ? s / n : 0; };
  for (const r of regions) {
    const a = Math.max(0, Math.floor(r.start / hop)), b = Math.min(v.length - 1, Math.ceil(r.end / hop));
    let regionPeak = 0;
    for (let i = a; i <= b; i++) regionPeak = Math.max(regionPeak, smooth(i));
    if (regionPeak <= 0) continue;
    const peaks: number[] = [];
    for (let i = a + 1; i < b; i++) {
      const s = smooth(i);
      if (s >= 0.35 * regionPeak && s > smooth(i - 1) && s >= smooth(i + 1)) {
        const last = peaks[peaks.length - 1];
        if (last !== undefined && (i - last) * hop < 0.11) { if (s > smooth(last)) peaks[peaks.length - 1] = i; } else peaks.push(i);
      }
    }
    if (peaks.length === 0) peaks.push(Math.round((a + b) / 2));
    // valley (minimum) between consecutive peaks = syllable boundary
    const edges: number[] = [a];
    for (let k = 0; k < peaks.length - 1; k++) {
      let mi = peaks[k]!, mv = Infinity;
      for (let i = peaks[k]!; i <= peaks[k + 1]!; i++) { const s = smooth(i); if (s < mv) { mv = s; mi = i; } }
      edges.push(mi);
    }
    edges.push(b);
    // A pronounced dip between syllables closes the mouth briefly (60 ms, >= 1 frame at 24 fps),
    // carved out of the neighbouring syllables so smoothing does not treat it as flicker.
    const CLOSE = 0.03;
    const closes = peaks.map((p, k) => {
      const next = peaks[k + 1];
      if (next === undefined) return false;
      return smooth(edges[k + 1]!) / Math.min(smooth(p), smooth(next)) < 0.6;
    });
    peaks.forEach((p, k) => {
      const ratio = smooth(p) / regionPeak;
      const viseme: Viseme = ratio >= 0.75 ? "AA" : ratio >= 0.5 ? "EH" : "OH";
      const start = edges[k]! * hop + (k > 0 && closes[k - 1] ? CLOSE : 0);
      const end = edges[k + 1]! * hop - (closes[k] ? CLOSE : 0);
      if (end > start) out.push({ start, end, viseme });
      if (closes[k]) out.push({ start: edges[k + 1]! * hop - CLOSE, end: edges[k + 1]! * hop + CLOSE, viseme: "TD" });
    });
  }
  return out;
}

/** Everything outside (slightly dilated) measured speech becomes REST. */
function gateToSpeech(intervals: VisemeInterval[], regions: Region[], dilate = 0.04): VisemeInterval[] {
  const R = regions.map((r) => ({ start: r.start - dilate, end: r.end + dilate }));
  const out: VisemeInterval[] = [];
  for (const iv of intervals) {
    if (iv.viseme === "REST") { out.push(iv); continue; }
    let cursor = iv.start;
    for (const r of R) {
      const a = Math.max(iv.start, r.start), b = Math.min(iv.end, r.end);
      if (b <= a) continue;
      if (a > cursor) out.push({ start: cursor, end: a, viseme: "REST" });
      out.push({ start: a, end: b, viseme: iv.viseme });
      cursor = b;
    }
    if (cursor < iv.end) out.push({ start: cursor, end: iv.end, viseme: "REST" });
  }
  return out;
}

export function finalizeIntervals(input: VisemeInterval[], duration: number, minHoldSec: number): VisemeInterval[] {
  const clipped = input
    .map((iv) => ({ ...iv, start: Math.max(0, iv.start), end: Math.min(duration, iv.end) }))
    .filter((iv) => iv.end > iv.start)
    .sort((a, b) => a.start - b.start);
  // resolve overlaps (later start wins) and fill gaps with REST
  let list: VisemeInterval[] = [];
  let cursor = 0;
  for (const iv of clipped) {
    if (iv.start > cursor + 1e-6) list.push({ start: cursor, end: iv.start, viseme: "REST" });
    const start = Math.max(iv.start, cursor);
    if (iv.end > start) { list.push({ start, end: iv.end, viseme: iv.viseme }); cursor = iv.end; }
  }
  if (cursor < duration) list.push({ start: cursor, end: duration, viseme: "REST" });
  if (list.length === 0) return [{ start: 0, end: duration, viseme: "REST" }];

  const merge = (arr: VisemeInterval[]) => {
    const m: VisemeInterval[] = [];
    for (const iv of arr) {
      const last = m[m.length - 1];
      if (last && last.viseme === iv.viseme && Math.abs(last.end - iv.start) < 1e-6) last.end = iv.end; else m.push({ ...iv });
    }
    return m;
  };
  list = merge(list);

  // Absorb blips shorter than the minimum hold (lip closures MBP/FV get a shorter floor - they are visually critical).
  for (let guard = 0; guard < 500; guard++) {
    let idx = -1, shortest = Infinity;
    list.forEach((iv, i) => {
      const dur = iv.end - iv.start;
      const floor = iv.viseme === "MBP" || iv.viseme === "FV" ? minHoldSec * 0.6 : minHoldSec;
      if (dur < floor && dur < shortest && list.length > 1) { idx = i; shortest = dur; }
    });
    if (idx < 0) break;
    const prev = list[idx - 1], next = list[idx + 1], cur = list[idx]!;
    if (prev && (!next || prev.end - prev.start >= next.end - next.start)) prev.end = cur.end;
    else if (next) next.start = cur.start;
    list.splice(idx, 1);
    list = merge(list);
  }
  return list.map((iv) => ({ start: r3(iv.start), end: r3(iv.end), viseme: iv.viseme }));
}

export function buildVisemeTrack(input: VisemeInput): VisemeTrack {
  const { text, language, duration, fps } = input;
  const { words, support } = textToWordUnits(text, language);
  const minHold = 1 / Math.max(1, fps);
  let quality: VisemeQuality;
  let raw: VisemeInterval[];

  if (support === "full" && words.length > 0 && alignmentUsable(text, input.alignment)) {
    quality = "provider-alignment";
    raw = fromAlignment(words, input.alignment as CharAlignment);
  } else if (support === "full" && words.length > 0 && input.speechRegions.length > 0) {
    quality = "audio-aligned";
    raw = fromAudioAlignment(words, input.speechRegions);
  } else {
    quality = "energy-only";
    raw = input.envelope ? fromEnergy(input.envelope, input.speechRegions) : [];
  }

  // Audio wins: no mouth movement where the audio is silent.
  const gated = gateToSpeech(raw, input.speechRegions);
  const local = finalizeIntervals(gated, duration, minHold);
  return {
    segmentId: input.segmentId,
    characterId: input.characterId,
    quality,
    intervals: local.map((iv) => ({ start: r3(iv.start + input.segmentStart), end: r3(iv.end + input.segmentStart), viseme: iv.viseme })),
  };
}

export function visemeAt(track: VisemeTrack, t: number): Viseme {
  const ivs = track.intervals;
  let lo = 0, hi = ivs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const iv = ivs[mid]!;
    if (t < iv.start) hi = mid - 1; else if (t >= iv.end) lo = mid + 1; else return iv.viseme;
  }
  return "REST";
}
