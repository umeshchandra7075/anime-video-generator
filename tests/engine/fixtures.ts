// Synthetic TEST audio - NOT speech and NOT a TTS provider. A harmonic buzz
// shaped by syllable-rate amplitude pulses inside known word windows, with
// silence between them. Because the ground-truth word timing is known
// independently of the code under test, alignment accuracy can be measured.
import fs from "node:fs";
import { getBinaries } from "../../src/lib/engine/binaries";
import os from "node:os";
import path from "node:path";

export interface WordWindow { start: number; end: number; f0?: number; syllablesPerSec?: number }

export function synthVoice(opts: { sampleRate?: number; duration: number; words: WordWindow[]; f0?: number; noise?: number; seed?: number }): Float32Array {
  const sr = opts.sampleRate ?? 24000;
  const n = Math.round(opts.duration * sr);
  const out = new Float32Array(n);
  let seed = opts.seed ?? 1234567;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff - 0.5; };
  const noise = opts.noise ?? 0.0004;
  for (let i = 0; i < n; i++) out[i] = rnd() * 2 * noise;
  for (const w of opts.words) {
    const f0 = w.f0 ?? opts.f0 ?? 130;
    const sylRate = w.syllablesPerSec ?? 5;
    const i0 = Math.round(w.start * sr), i1 = Math.min(n, Math.round(w.end * sr));
    let phase = 0;
    for (let i = i0; i < i1; i++) {
      const t = (i - i0) / sr, len = (i1 - i0) / sr;
      const edge = Math.min(1, t / 0.02, (len - t) / 0.03);           // 20ms attack / 30ms release
      const syl = 0.55 + 0.45 * Math.abs(Math.sin(Math.PI * sylRate * t)); // syllable pulsing
      phase += (2 * Math.PI * f0) / sr;
      let s = 0;
      for (let h = 1; h <= 8; h++) s += Math.sin(h * phase) / h;
      out[i] = (out[i] ?? 0) + 0.32 * edge * syl * s * 0.6;
    }
  }
  return out;
}

export function writeWav(file: string, samples: Float32Array, sr = 24000): string {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i]! * 32767))), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
  return file;
}

export function tmpDir(prefix = "avg-test-"): string { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
export function rmDir(d: string) { fs.rmSync(d, { recursive: true, force: true }); }

import { execFileSync } from "node:child_process";
export function ff(args: string[]): void { execFileSync(getBinaries().ffmpeg, ["-y", "-v", "error", ...args], { maxBuffer: 1 << 28 }); }
export function makePng(file: string, color: string, w: number, h: number): string { ff(["-f", "lavfi", "-i", `color=c=${color}:s=${w}x${h}`, "-frames:v", "1", file]); return file; }
export function rmsDb(samples: Float32Array, sr: number, t0: number, t1: number): number {
  const a = Math.max(0, Math.floor(t0 * sr)), b = Math.min(samples.length, Math.floor(t1 * sr));
  let s = 0; for (let i = a; i < b; i++) s += samples[i]! * samples[i]!;
  return 10 * Math.log10(s / Math.max(1, b - a) + 1e-12);
}
export function firstOnset(samples: Float32Array, sr: number, thr: number, from = 0): number {
  for (let i = Math.floor(from * sr); i < samples.length; i++) if (Math.abs(samples[i]!) > thr) return i / sr;
  return -1;
}
