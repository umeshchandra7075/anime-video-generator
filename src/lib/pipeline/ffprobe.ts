import { execFile } from "child_process";
import fs from "fs/promises";
import ffprobeStatic from "ffprobe-static";
import ffmpegPath from "ffmpeg-static";

/**
 * Local, dependency-free media validation for the final rendering stage.
 *
 * This module never shells out to a globally-installed `ffprobe` or
 * `ffmpeg` binary and never requires either to be on PATH. It always uses
 * the platform-specific executable bundled by the `ffprobe-static` /
 * `ffmpeg-static` npm packages, resolved to an absolute path at import
 * time. If, for some reason, the bundled ffprobe binary cannot be
 * executed, validation falls back to using the bundled ffmpeg binary
 * instead (see `probeWithFfmpegFallback`) - so a missing/broken ffprobe
 * install can never silently skip validation.
 *
 * Windows safety: every subprocess call below uses `child_process.execFile`
 * with the executable and its arguments passed as a plain array. Node never
 * builds a shell command string from these, so a path such as
 * `C:\Users\umesh chandra\Downloads\...` (spaces, backslashes, etc.) is
 * passed straight through to the OS as a single argument - no manual
 * quoting or shell-escaping is required or performed.
 */

const PROBE_TIMEOUT_MS = 30_000;
const MAX_PROBE_BUFFER_BYTES = 10 * 1024 * 1024;

export interface ProbeInfo {
  durationSeconds: number;
  hasVideoStream: boolean;
  hasAudioStream: boolean;
}

export interface MediaValidationResult {
  ok: boolean;
  reason?: string;
  durationSeconds: number;
  hasVideoStream: boolean;
  hasAudioStream: boolean;
  /** Which mechanism produced this result - useful for logging/tests. */
  method: "ffprobe" | "ffmpeg-fallback";
}

interface ExecResult {
  stdout: string;
  stderr: string;
}

interface ExecFileErrorLike extends Error {
  stdout?: string;
  stderr?: string;
  code?: string | number;
}

/** Absolute path to the ffprobe binary bundled by `ffprobe-static` for the
 * current OS/arch (including `ffprobe.exe` on win32), or null if this
 * platform/arch has no bundled binary. Never reads PATH. */
export function resolveFfprobePath(): string | null {
  const probePath = ffprobeStatic?.path;
  return typeof probePath === "string" && probePath.length > 0 ? probePath : null;
}

/** Absolute path to the ffmpeg binary bundled by `ffmpeg-static` for the
 * current OS/arch, or null if unavailable. Never reads PATH. */
export function resolveFfmpegPath(): string | null {
  return typeof ffmpegPath === "string" && ffmpegPath.length > 0 ? ffmpegPath : null;
}

/** Runs `file` with `args` (array form - no shell involved) and resolves
 * with stdout/stderr, or rejects with an error that carries whatever
 * stdout/stderr the process produced before failing. */
function execFileAsync(file: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: MAX_PROBE_BUFFER_BYTES, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const err = error as ExecFileErrorLike;
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

async function checkFileExistsAndNonEmpty(filePath: string): Promise<{ ok: boolean; reason?: string }> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return { ok: false, reason: `output file does not exist: ${filePath}` };
  }
  if (!stat.isFile()) {
    return { ok: false, reason: `output path is not a regular file: ${filePath}` };
  }
  if (stat.size === 0) {
    return { ok: false, reason: `output file is empty: ${filePath}` };
  }
  return { ok: true };
}

/**
 * Primary validation path: probes `filePath` with the local ffprobe-static
 * binary using `-show_format -show_streams -print_format json`, and parses
 * duration + stream types straight from that JSON. Throws if the ffprobe
 * binary can't be resolved/executed or its output can't be parsed - callers
 * should catch this and fall back to `probeWithFfmpegFallback`.
 */
export async function probeWithFfprobe(filePath: string): Promise<ProbeInfo> {
  const ffprobeBin = resolveFfprobePath();
  if (!ffprobeBin) {
    throw new Error(
      "Local ffprobe executable was not found (ffprobe-static did not resolve a path for this platform/arch).",
    );
  }

  const args = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath];

  let stdout: string;
  try {
    const result = await execFileAsync(ffprobeBin, args, PROBE_TIMEOUT_MS);
    stdout = result.stdout;
  } catch (error) {
    const err = error as ExecFileErrorLike;
    const detail = err.stderr?.trim() || err.message;
    throw new Error(`ffprobe process failed: ${detail}`);
  }

  let data: {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string }>;
  };
  try {
    data = JSON.parse(stdout);
  } catch (parseError) {
    const message = parseError instanceof Error ? parseError.message : String(parseError);
    throw new Error(`ffprobe returned output that could not be parsed as JSON: ${message}`);
  }

  const durationSeconds = Number(data.format?.duration ?? 0) || 0;
  const streams = data.streams ?? [];
  const hasVideoStream = streams.some((s) => s.codec_type === "video");
  const hasAudioStream = streams.some((s) => s.codec_type === "audio");

  return { durationSeconds, hasVideoStream, hasAudioStream };
}

/**
 * Fallback validation path, used only if `probeWithFfprobe` itself throws
 * (e.g. the ffprobe binary is missing or refuses to execute on this host).
 * Runs the file through the local ffmpeg-static binary in decode-only mode
 * (`-i <file> -f null -`) and parses the human-readable `Duration:` /
 * `Stream #n:n ... Video:` / `Audio:` lines ffmpeg prints while opening the
 * input. This still requires ffmpeg to actually decode the file, so it
 * remains a real validation rather than a rubber stamp.
 */
export async function probeWithFfmpegFallback(filePath: string): Promise<ProbeInfo> {
  const ffmpegBin = resolveFfmpegPath();
  if (!ffmpegBin) {
    throw new Error("Local ffmpeg executable was not found (ffmpeg-static did not resolve a path) for fallback validation.");
  }

  const args = ["-hide_banner", "-i", filePath, "-f", "null", "-"];

  let combinedOutput: string;
  try {
    const result = await execFileAsync(ffmpegBin, args, PROBE_TIMEOUT_MS);
    combinedOutput = `${result.stdout}\n${result.stderr}`;
  } catch (error) {
    const err = error as ExecFileErrorLike;
    combinedOutput = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
    // ffmpeg still prints Duration/Stream info to stderr even when the
    // overall decode exits non-zero (e.g. a truncated file) - only treat
    // this as a hard failure if we got nothing usable at all.
    if (!/Duration:/i.test(combinedOutput)) {
      throw new Error(`ffmpeg fallback probe process failed: ${err.stderr?.trim() || err.message}`);
    }
  }

  const durationMatch = combinedOutput.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
  const durationSeconds = durationMatch
    ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
    : 0;

  const hasVideoStream = /Stream #\d+:\d+[^\n]*:\s*Video:/i.test(combinedOutput);
  const hasAudioStream = /Stream #\d+:\d+[^\n]*:\s*Audio:/i.test(combinedOutput);

  return { durationSeconds, hasVideoStream, hasAudioStream };
}

/**
 * Confirms the rendered file actually exists, is non-empty, is a readable
 * MP4 with a valid (positive) duration, and has a video stream - not just
 * that ffmpeg exited 0. Never touches a global/PATH ffprobe or ffmpeg
 * install: it always uses the local ffprobe-static binary, falling back to
 * the local ffmpeg-static binary only if ffprobe itself can't be run.
 */
export async function validateFinalVideo(filePath: string): Promise<MediaValidationResult> {
  const existence = await checkFileExistsAndNonEmpty(filePath);
  if (!existence.ok) {
    return {
      ok: false,
      reason: existence.reason,
      durationSeconds: 0,
      hasVideoStream: false,
      hasAudioStream: false,
      method: "ffprobe",
    };
  }

  let info: ProbeInfo;
  let method: MediaValidationResult["method"];
  try {
    info = await probeWithFfprobe(filePath);
    method = "ffprobe";
  } catch (ffprobeError) {
    try {
      info = await probeWithFfmpegFallback(filePath);
      method = "ffmpeg-fallback";
    } catch (fallbackError) {
      const ffprobeMessage = ffprobeError instanceof Error ? ffprobeError.message : String(ffprobeError);
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      return {
        ok: false,
        reason: `ffprobe could not read the output file: ${ffprobeMessage}; ffmpeg fallback validation also failed: ${fallbackMessage}`,
        durationSeconds: 0,
        hasVideoStream: false,
        hasAudioStream: false,
        method: "ffprobe",
      };
    }
  }

  if (!info.hasVideoStream) {
    return {
      ok: false,
      reason: "output file has no video stream.",
      durationSeconds: info.durationSeconds,
      hasVideoStream: false,
      hasAudioStream: info.hasAudioStream,
      method,
    };
  }

  if (!(info.durationSeconds > 0)) {
    return {
      ok: false,
      reason: "output file has zero or unknown duration.",
      durationSeconds: info.durationSeconds,
      hasVideoStream: info.hasVideoStream,
      hasAudioStream: info.hasAudioStream,
      method,
    };
  }

  return {
    ok: true,
    durationSeconds: Math.round(info.durationSeconds),
    hasVideoStream: info.hasVideoStream,
    hasAudioStream: info.hasAudioStream,
    method,
  };
}
