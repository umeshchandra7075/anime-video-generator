// Per-dialogue-segment TTS. Guarantees:
//  * each segment is synthesised with ITS OWN speaker's voice (never a neighbour's)
//  * emotion -> ONLY provider-supported parameters (the rest reported as ignored)
//  * deterministic cache: identical request => stored audio reused, zero API calls
//  * bounded failure: timeout + retry with exponential backoff per call; a failing
//    segment is reported as failed while the others still succeed
//  * durations are MEASURED from the decoded audio, never estimated
//  * a "not configured"/auth failure is reported honestly and stops further calls
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CharAlignment, PlannedSegment, SegmentAudio } from "./types";
import { applyPronunciation, mapEmotionToVoiceParams } from "./emotion";
import type { VoiceBaseSettings, VoiceCapabilities } from "./emotion";
import { ttsCacheKey } from "./cacheKey";
import { withRetry } from "./retry";
import type { RetryOptions } from "./retry";
import { analyzeSpeechAudio } from "./audioAnalysis";
import type { Envelope, Region } from "./audioAnalysis";

export interface SynthRequest {
  text: string; language: string; voiceId?: string; modelId?: string;
  stability?: number; similarityBoost?: number; style?: number; speed?: number; instructions?: string; withTimestamps?: boolean;
}
export interface SynthResult { audio: Buffer; mimeType: string; alignment?: CharAlignment; metadata?: Record<string, unknown> }
export interface VoiceSynth {
  name: string;
  capabilities: VoiceCapabilities;
  synthesize(req: SynthRequest, signal: AbortSignal): Promise<SynthResult>;
}
export interface BlobStore {
  exists(key: string): Promise<boolean>;
  get(key: string): Promise<Buffer>;
  put(key: string, data: Buffer, mimeType: string): Promise<void>;
}
export interface AnalysisResult { durationSeconds: number; speechRegions: Region[]; envelope?: { hopSec: number; values: number[] } }
export type Analyzer = (audio: Buffer, mimeType: string) => Promise<AnalysisResult>;

export interface SegmentVoiceSettings { voiceId?: string; modelId?: string; base: VoiceBaseSettings; lexicon?: Record<string, string> | null }

export type VoiceErrorCode = "NOT_CONFIGURED" | "AUTH" | "TIMEOUT" | "PROVIDER" | "EMPTY_AUDIO" | "SILENT_AUDIO" | "ANALYSIS";
export interface VoiceError { code: VoiceErrorCode; message: string; retryable: boolean }
export type SegmentOutcome =
  | { ok: true; segment: PlannedSegment; audio: SegmentAudio; cached: boolean; ignoredParams: string[]; attempts: number; envelope?: Envelope }
  | { ok: false; segment: PlannedSegment; error: VoiceError };

export interface SynthesizeOptions {
  segments: PlannedSegment[];
  provider: VoiceSynth;
  store: BlobStore;
  keyFor: (cacheKey: string, ext: "mp3" | "meta.json") => string;
  language: string;
  settingsFor: (segment: PlannedSegment) => SegmentVoiceSettings;
  analyze?: Analyzer;
  retry?: RetryOptions;
  concurrency?: number;
  useTimestamps?: boolean;
  log?: (line: string) => void;
  onSegmentDone?: (done: number, total: number) => void;
}

const LABEL: Record<string, string> = { elevenlabs: "ElevenLabs", openai: "OpenAI", google: "Google TTS", azure: "Azure Speech" };
const label = (p: string) => LABEL[p] ?? p;

export function describeVoiceError(provider: string, err: unknown): VoiceError {
  const e = err as { name?: string; message?: string; statusCode?: number } | null;
  const inner = (err as { lastError?: unknown } | null)?.lastError; // RetriesExhaustedError wraps the final cause
  if (inner && e?.name === "RetriesExhaustedError") { const d = describeVoiceError(provider, inner); return { ...d, message: `${d.message} (gave up after retries)` }; }
  switch (e?.name) {
    case "ProviderNotConfiguredError": return { code: "NOT_CONFIGURED", message: `${label(provider)} API key is not configured.`, retryable: false };
    case "ProviderAuthError": return { code: "AUTH", message: `${label(provider)} rejected the API key.`, retryable: false };
    case "ProviderTimeoutError": case "AttemptTimeoutError": return { code: "TIMEOUT", message: `${label(provider)} timed out.`, retryable: true };
    default: return { code: "PROVIDER", message: e?.message ?? String(err), retryable: (e?.statusCode ?? 500) >= 500 || e?.statusCode === 429 };
  }
}

export const defaultAnalyzer: Analyzer = async (audio, mimeType) => {
  const ext = /wav/.test(mimeType) ? "wav" : /ogg/.test(mimeType) ? "ogg" : "mp3";
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "avg-voice-"));
  try {
    const file = path.join(dir, `a.${ext}`);
    await fs.writeFile(file, audio);
    const a = await analyzeSpeechAudio(file);
    return { durationSeconds: a.durationSeconds, speechRegions: a.speechRegions, envelope: { hopSec: a.envelope.hopSec, values: Array.from(a.envelope.values, (v) => Math.round(v * 10000) / 10000) } };
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
};

interface MetaFile { durationSeconds: number; speechRegions: Region[]; mimeType: string; alignment?: CharAlignment; providerMeta?: Record<string, unknown>; envelope?: { hopSec: number; values: number[] } }
const toEnv = (e?: { hopSec: number; values: number[] }): Envelope | undefined => (e ? { hopSec: e.hopSec, values: Float32Array.from(e.values) } : undefined);

export async function synthesizeSegments(o: SynthesizeOptions): Promise<SegmentOutcome[]> {
  const log = o.log ?? (() => undefined);
  const analyze = o.analyze ?? defaultAnalyzer;
  const inflight = new Map<string, Promise<SegmentOutcome>>();
  let fatal: VoiceError | null = null;

  const runOne = async (segment: PlannedSegment): Promise<SegmentOutcome> => {
    if (fatal) return { ok: false, segment, error: fatal };
    const s = o.settingsFor(segment);
    const voiceId = segment.voice?.voiceId ?? s.voiceId; // an unassigned speaker gets the DEFAULT voice - never another character's
    const spoken = applyPronunciation(segment.text, s.lexicon);
    const mapped = mapEmotionToVoiceParams(segment.profile, o.provider.capabilities, s.base);
    const p = mapped.settings;
    const cacheKey = ttsCacheKey({
      characterId: segment.characterId, provider: o.provider.name, model: s.modelId, voiceId: voiceId ?? "", text: spoken,
      emotion: segment.emotion, intensity: segment.intensity, speed: p.speed, pitch: p.pitchSemitones, stability: p.stability,
      similarityBoost: p.similarityBoost, style: p.style, language: o.language, schema: o.useTimestamps ? 2 : 1,
    });
    const pending = inflight.get(cacheKey);
    if (pending) { const r = await pending; return r.ok ? { ...r, segment, cached: true } : { ...r, segment }; }
    const job = (async (): Promise<SegmentOutcome> => {
      const audioKey = o.keyFor(cacheKey, "mp3"), metaKey = o.keyFor(cacheKey, "meta.json");
      try {
        if (await o.store.exists(metaKey)) { // meta is written AFTER the audio, so its presence implies the audio exists
          const meta = JSON.parse((await o.store.get(metaKey)).toString("utf8")) as MetaFile;
          log(`[VOICE] cache hit ${segment.segmentId} (${segment.speakerName})`);
          return { ok: true, segment, cached: true, attempts: 0, ignoredParams: mapped.ignored, envelope: toEnv(meta.envelope), audio: { storageKey: audioKey, mimeType: meta.mimeType, durationSeconds: meta.durationSeconds, cacheKey, alignment: meta.alignment, speechRegions: meta.speechRegions } };
        }
        let attempts = 0;
        const res = await withRetry(async (signal) => {
          attempts++;
          return o.provider.synthesize({
            text: spoken, language: o.language, voiceId, modelId: s.modelId, stability: p.stability, similarityBoost: p.similarityBoost, style: p.style, speed: p.speed,
            instructions: p.instructions, withTimestamps: o.useTimestamps,
          }, signal);
        }, {
          retries: 3, baseDelayMs: 750, timeoutMs: 120_000, ...(o.retry ?? {}),
          onRetry: (i) => { log(`[VOICE] ${segment.segmentId} Retry ${i.attempt}/${i.maxAttempts - 1} in ${i.delayMs}ms: ${(i.error as Error)?.message}`); o.retry?.onRetry?.(i); },
        });
        if (!res.audio || res.audio.length === 0) return { ok: false, segment, error: { code: "EMPTY_AUDIO", message: `${label(o.provider.name)} returned no audio for ${segment.segmentId}.`, retryable: true } };
        let measured: AnalysisResult;
        try { measured = await analyze(res.audio, res.mimeType); }
        catch (e) { return { ok: false, segment, error: { code: "ANALYSIS", message: `Could not decode the audio for ${segment.segmentId}: ${(e as Error).message}`, retryable: true } }; }
        if (!(measured.durationSeconds > 0.1)) return { ok: false, segment, error: { code: "EMPTY_AUDIO", message: `Audio for ${segment.segmentId} is ${measured.durationSeconds.toFixed(2)}s long.`, retryable: true } };
        if (measured.speechRegions.length === 0 && /[\p{L}\p{N}]/u.test(spoken)) return { ok: false, segment, error: { code: "SILENT_AUDIO", message: `${label(o.provider.name)} returned silent audio for ${segment.segmentId}.`, retryable: true } };
        await o.store.put(audioKey, res.audio, res.mimeType);
        const meta: MetaFile = { durationSeconds: measured.durationSeconds, speechRegions: measured.speechRegions, mimeType: res.mimeType, alignment: res.alignment, providerMeta: res.metadata, envelope: measured.envelope };
        await o.store.put(metaKey, Buffer.from(JSON.stringify(meta)), "application/json");
        log(`[VOICE] ${segment.segmentId} ${segment.speakerName} (${segment.emotion}) ${measured.durationSeconds.toFixed(2)}s attempts=${attempts}`);
        return { ok: true, segment, cached: false, attempts, ignoredParams: mapped.ignored, envelope: toEnv(measured.envelope), audio: { storageKey: audioKey, mimeType: res.mimeType, durationSeconds: measured.durationSeconds, cacheKey, alignment: res.alignment, speechRegions: measured.speechRegions } };
      } catch (err) {
        const error = describeVoiceError(o.provider.name, err);
        if (error.code === "NOT_CONFIGURED" || error.code === "AUTH") fatal = error; // do not hammer a provider that cannot work
        log(`[ERROR] [VOICE] ${segment.segmentId}: ${error.message}`);
        return { ok: false, segment, error };
      }
    })();
    inflight.set(cacheKey, job);
    return job;
  };

  const results: SegmentOutcome[] = new Array(o.segments.length);
  let next = 0, finished = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(o.concurrency ?? 3, o.segments.length)) }, async () => {
    for (;;) { const i = next++; if (i >= o.segments.length) return; results[i] = await runOne(o.segments[i]!); finished++; o.onSegmentDone?.(finished, o.segments.length); }
  });
  await Promise.all(workers);
  return results;
}
