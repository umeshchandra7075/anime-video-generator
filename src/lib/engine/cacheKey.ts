import { createHash } from "node:crypto";

/** JSON.stringify with sorted keys and undefined dropped, so logically equal
 * inputs always hash identically regardless of property order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function hashParts(parts: unknown): string {
  return createHash("sha256").update(stableStringify(parts)).digest("hex");
}

export function normalizeText(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

export interface TtsCacheInput {
  characterId: string;
  provider: string;
  model?: string;
  voiceId: string;
  text: string;
  emotion: string;
  intensity?: number;
  speed?: number;
  pitch?: number;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  language?: string;
  /** Bumped when synthesis semantics change (e.g. timestamps requested). */
  schema?: number;
}

/** TTS cache key: identical request => identical key => reuse the stored audio. */
export function ttsCacheKey(input: TtsCacheInput): string {
  return hashParts({ kind: "tts", schema: 1, ...input, text: normalizeText(input.text) });
}

export function sfxCacheKey(type: string, durationSec: number, seed: string): string {
  return hashParts({ kind: "sfx", schema: 1, type, durationSec: Math.round(durationSec * 1000), seed });
}
