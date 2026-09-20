import {
  MusicProvider,
  MusicGenerationRequest,
  MusicJobHandle,
  MusicJobResult,
} from "@/lib/ai/interfaces/music-provider";
import ffmpegPath from "ffmpeg-static";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";

const execFileAsync = promisify(execFile);

const jobs = new Map<string, MusicJobResult>();

// FFmpeg subprocess safety: bound how long a single generation may run so a
// stuck/hung process can never wedge the worker or leak indefinitely.
const FFMPEG_TIMEOUT_MS = 30_000;

type MusicMood = "calm" | "dramatic" | "action" | "emotional";
type SfxType = "whoosh" | "impact" | "transition";

/**
 * Free, royalty-free, fully local music/SFX provider used as a fallback when
 * a paid AI audio provider (e.g. Pollinations) is unavailable, unconfigured,
 * or out of balance. Everything here is synthesized on-device with FFmpeg's
 * `lavfi` audio-generator filters (sine waves, noise, tremolo/vibrato,
 * fades) - no external network calls, no copyrighted or downloaded audio,
 * nothing that requires an API key or a paid balance.
 *
 * Implements the same MusicProvider interface as PollinationsMusicProvider
 * so it's a drop-in replacement at the call site (see musicStage.ts).
 */
export class LocalAudioProvider implements MusicProvider {
  readonly name = "local-ffmpeg-fallback";

  async submit(request: MusicGenerationRequest): Promise<MusicJobHandle> {
    if (!ffmpegPath) {
      throw new Error("FFmpeg executable was not found for the local audio fallback.");
    }

    const jobId = randomUUID();
    jobs.set(jobId, { status: "processing" });

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "local-audio-"));
    const outPath = path.join(tempDir, "out.mp3");

    try {
      const isSfx = request.kind === "sfx";
      // SFX are short one-shots; music beds run for the full requested
      // duration. Both are clamped to sane floors/ceilings so a bad input
      // (0, negative, absurdly large) can never produce a broken or
      // runaway ffmpeg invocation.
      const duration = isSfx
        ? clamp(request.durationSeconds || 0.6, 0.2, 6)
        : clamp(request.durationSeconds || 6, 2, 600);

      const graph = isSfx
        ? buildSfxGraph(resolveSfxType(request.description), duration)
        : buildMusicGraph(resolveMood(request.mood), duration);

      const args: string[] = ["-y"];
      for (const input of graph.inputs) {
        args.push("-f", "lavfi", "-i", input);
      }
      args.push(
        "-filter_complex",
        graph.filterComplex,
        "-map",
        "[out]",
        "-ac",
        "2",
        "-ar",
        "44100",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "128k",
        outPath,
      );

      await execFileAsync(ffmpegPath, args, { timeout: FFMPEG_TIMEOUT_MS });

      const audioBuffer = await fs.readFile(outPath);
      if (audioBuffer.byteLength === 0) {
        throw new Error("Local audio fallback produced an empty file.");
      }

      jobs.set(jobId, {
        status: "completed",
        audioBase64: audioBuffer.toString("base64"),
        mimeType: "audio/mpeg",
        providerMetadata: {
          provider: this.name,
          kind: request.kind,
          mood: isSfx ? undefined : resolveMood(request.mood),
          sfxType: isSfx ? resolveSfxType(request.description) : undefined,
          durationSeconds: duration,
          generator: "procedural-ffmpeg-lavfi",
        },
      });

      return { providerJobId: jobId, status: "completed" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Local audio fallback generation failed.";
      jobs.set(jobId, { status: "failed", errorMessage: message });
      throw error;
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async getStatus(providerJobId: string): Promise<MusicJobResult> {
    const result = jobs.get(providerJobId);

    if (!result) {
      return { status: "failed", errorMessage: "Local audio job was not found." };
    }

    return result;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Maps the app's free-text/enum mood values (see MUSIC_MOODS in
 * src/lib/validation/schemas.ts: cinematic, emotional, horror, fantasy,
 * action, romantic, mystery, none) plus any looser AI-suggested mood string
 * onto the four procedural beds we know how to synthesize.
 */
function resolveMood(mood: string): MusicMood {
  const m = (mood || "").toLowerCase();

  if (/(action|battle|fight|chase|intense|energetic|thriller)/.test(m)) return "action";
  if (/(emotional|romantic|sad|touching|bitter|nostalgic|love)/.test(m)) return "emotional";
  if (/(dramatic|cinematic|horror|mystery|dark|tense|suspense|epic)/.test(m)) return "dramatic";
  if (/(calm|soft|fantasy|whimsical|peaceful|gentle|dream)/.test(m)) return "calm";

  return "calm";
}

function resolveSfxType(description?: string): SfxType {
  const d = (description || "").toLowerCase();

  if (/(impact|hit|punch|crash|boom|thud|collision|slam)/.test(d)) return "impact";
  if (/(transition|stinger|swipe|scene change|reveal|sweep)/.test(d)) return "transition";
  return "whoosh"; // covers "whoosh", "wind", generic movement, and unmatched/empty descriptions
}

interface FilterGraph {
  inputs: string[];
  filterComplex: string;
}

/**
 * Each mood layers 2-3 `lavfi` tone/noise sources at low volume, blends them
 * with `amix`, and shapes the result with fade-in/out so loop points are
 * inaudible when the composite stage loops this bed under a scene. Nothing
 * here reproduces or samples any existing recording - it's generated from
 * pure waveform expressions, so there is no copyright concern.
 */
function buildMusicGraph(mood: MusicMood, duration: number): FilterGraph {
  const fadeIn = Math.min(2, duration * 0.25);
  const fadeOut = Math.min(2, duration * 0.25);
  const fadeOutStart = Math.max(0, duration - fadeOut);

  switch (mood) {
    case "calm":
      return {
        inputs: [
          `sine=frequency=261.63:duration=${duration}`,
          `sine=frequency=329.63:duration=${duration}`,
          `sine=frequency=392.00:duration=${duration}`,
        ],
        filterComplex:
          `[0:a]volume=0.18[a0];[1:a]volume=0.14[a1];[2:a]volume=0.12[a2];` +
          `[a0][a1][a2]amix=inputs=3:duration=longest[mix];` +
          `[mix]afade=t=in:st=0:d=${fadeIn},afade=t=out:st=${fadeOutStart}:d=${fadeOut},alimiter=limit=0.9[out]`,
      };

    case "dramatic":
      return {
        inputs: [
          `sine=frequency=98:duration=${duration}`,
          `sine=frequency=116.54:duration=${duration}`,
          `sine=frequency=146.83:duration=${duration}`,
        ],
        filterComplex:
          `[0:a]volume=0.25[a0];[1:a]volume=0.15,tremolo=f=0.15:d=0.6[a1];[2:a]volume=0.1[a2];` +
          `[a0][a1][a2]amix=inputs=3:duration=longest[mix];` +
          `[mix]afade=t=in:st=0:d=${fadeIn},afade=t=out:st=${fadeOutStart}:d=${fadeOut},alimiter=limit=0.9[out]`,
      };

    case "action":
      return {
        inputs: [`sine=frequency=110:duration=${duration}`, `sine=frequency=146.83:duration=${duration}`],
        filterComplex:
          `[0:a]tremolo=f=4:d=0.7,volume=0.35[a0];[1:a]tremolo=f=8:d=0.5,volume=0.2[a1];` +
          `[a0][a1]amix=inputs=2:duration=longest[mix];` +
          `[mix]afade=t=in:st=0:d=${Math.min(0.3, fadeIn)},afade=t=out:st=${fadeOutStart}:d=${fadeOut},alimiter=limit=0.9[out]`,
      };

    case "emotional":
      return {
        inputs: [`sine=frequency=293.66:duration=${duration}`, `sine=frequency=369.99:duration=${duration}`],
        filterComplex:
          `[0:a]vibrato=f=5:d=0.3,volume=0.2[a0];[1:a]vibrato=f=4:d=0.2,volume=0.12[a1];` +
          `[a0][a1]amix=inputs=2:duration=longest[mix];` +
          `[mix]afade=t=in:st=0:d=${fadeIn},afade=t=out:st=${fadeOutStart}:d=${fadeOut},alimiter=limit=0.9[out]`,
      };
  }
}

function buildSfxGraph(sfx: SfxType, duration: number): FilterGraph {
  switch (sfx) {
    case "whoosh":
      return {
        inputs: [`anoisesrc=color=pink:duration=${duration}:amplitude=0.8`],
        filterComplex:
          `[0:a]bandpass=f=800:width_type=h:w=3000,volume=0.9,` +
          `afade=t=in:st=0:d=${Math.min(0.1, duration * 0.3)},afade=t=out:st=${Math.max(0, duration - duration * 0.4)}:d=${duration * 0.4}[out]`,
      };

    case "impact":
      return {
        inputs: [`sine=frequency=80:duration=${duration}`, `anoisesrc=color=white:duration=${Math.min(0.15, duration)}:amplitude=1`],
        filterComplex:
          `[0:a]afade=t=out:st=${Math.max(0, duration * 0.1)}:d=${duration * 0.9},volume=1.0[a0];` +
          `[1:a]lowpass=f=400,volume=0.8,apad=pad_dur=${Math.max(0, duration - Math.min(0.15, duration))}[a1];` +
          `[a0][a1]amix=inputs=2:duration=first[out]`,
      };

    case "transition":
      return {
        inputs: [`aevalsrc=0.6*sin(2*PI*(300+700*t)*t):duration=${duration}`],
        filterComplex:
          `[0:a]afade=t=in:st=0:d=${Math.min(0.05, duration * 0.2)},` +
          `afade=t=out:st=${Math.max(0, duration - duration * 0.35)}:d=${duration * 0.35},volume=0.8[out]`,
      };
  }
}
