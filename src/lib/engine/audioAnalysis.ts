// Measures REAL audio. Nothing here trusts a provider-reported or estimated
// duration: the duration is the number of decoded samples / sample rate.
import { getBinaries, runProcess } from "./binaries";

export interface Region { start: number; end: number }
export interface Envelope { hopSec: number; values: Float32Array }

export interface SpeechAnalysis {
  durationSeconds: number;
  sampleRate: number;
  envelope: Envelope;
  speechRegions: Region[];
  peakLinear: number;
  noiseFloorLinear: number;
}

export async function decodeMonoPcm(file: string, sampleRate = 16000): Promise<Float32Array> {
  const { stdout } = await runProcess(getBinaries().ffmpeg, ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(sampleRate), "-f", "s16le", "-"]);
  const n = Math.floor(stdout.byteLength / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = stdout.readInt16LE(i * 2) / 32768;
  return out;
}

/** Windowed RMS, one value per hop. */
export function rmsEnvelope(samples: Float32Array, sampleRate: number, hopMs = 10, winMs = 25): Envelope {
  const hop = Math.max(1, Math.round((sampleRate * hopMs) / 1000));
  const win = Math.max(hop, Math.round((sampleRate * winMs) / 1000));
  const frames = Math.max(0, Math.ceil(samples.length / hop));
  const values = new Float32Array(frames);
  // prefix sums of squares for O(n)
  const cum = new Float64Array(samples.length + 1);
  for (let i = 0; i < samples.length; i++) cum[i + 1] = cum[i]! + samples[i]! * samples[i]!;
  for (let f = 0; f < frames; f++) {
    const centre = f * hop + hop / 2;
    const a = Math.max(0, Math.round(centre - win / 2));
    const b = Math.min(samples.length, Math.round(centre + win / 2));
    values[f] = b > a ? Math.sqrt((cum[b]! - cum[a]!) / (b - a)) : 0;
  }
  return { hopSec: hop / sampleRate, values };
}

function percentile(values: Float32Array, p: number): number {
  if (values.length === 0) return 0;
  const sorted = Float32Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))]!;
}

export interface SpeechDetectOptions { minRegionSec?: number; mergeGapSec?: number; onFraction?: number; offRatio?: number; absoluteFloor?: number }

/** Adaptive-threshold voice activity with hysteresis; brief dips are merged so
 * a word's internal consonant closures don't split it, while true pauses do. */
export function detectSpeechRegions(env: Envelope, opts: SpeechDetectOptions = {}): { regions: Region[]; peak: number; floor: number } {
  const v = env.values;
  const peak = percentile(v, 0.95);
  const floor = percentile(v, 0.10);
  const onThr = Math.max(opts.absoluteFloor ?? 0.004, floor + (peak - floor) * (opts.onFraction ?? 0.08));
  const offThr = onThr * (opts.offRatio ?? 0.6);
  const raw: Region[] = [];
  let start = -1;
  for (let i = 0; i < v.length; i++) {
    const x = v[i]!;
    if (start < 0 && x >= onThr) start = i;
    else if (start >= 0 && x < offThr) { raw.push({ start: start * env.hopSec, end: i * env.hopSec }); start = -1; }
  }
  if (start >= 0) raw.push({ start: start * env.hopSec, end: v.length * env.hopSec });

  const mergeGap = opts.mergeGapSec ?? 0.14;
  const merged: Region[] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end < mergeGap) last.end = r.end;
    else merged.push({ ...r });
  }
  const minRegion = opts.minRegionSec ?? 0.08;
  return { regions: merged.filter((r) => r.end - r.start >= minRegion), peak, floor };
}

export async function analyzeSpeechAudio(file: string, opts: SpeechDetectOptions = {}): Promise<SpeechAnalysis> {
  const sampleRate = 16000;
  const samples = await decodeMonoPcm(file, sampleRate);
  const envelope = rmsEnvelope(samples, sampleRate);
  const { regions, peak, floor } = detectSpeechRegions(envelope, opts);
  return { durationSeconds: samples.length / sampleRate, sampleRate, envelope, speechRegions: regions, peakLinear: peak, noiseFloorLinear: floor };
}
