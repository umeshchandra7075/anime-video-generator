import { createRequire } from "node:module";
import path from "node:path";
import { execFile } from "node:child_process";

export interface Binaries { ffmpeg: string; ffprobe: string }
let cached: Binaries | null = null;

function tryStatic(pkg: "ffmpeg-static" | "ffprobe-static"): string | null {
  try {
    // createRequire against cwd keeps bundlers from statically analysing this optional dependency.
    const req = createRequire(path.join(process.cwd(), "noop.js"));
    const mod = req(pkg) as string | { path?: string } | null;
    const p = typeof mod === "string" ? mod : mod?.path;
    return p || null;
  } catch {
    return null;
  }
}

/** FFMPEG_PATH / FFPROBE_PATH env > bundled ffmpeg-static / ffprobe-static > PATH. */
export function getBinaries(): Binaries {
  if (cached) return cached;
  cached = {
    ffmpeg: process.env.FFMPEG_PATH || tryStatic("ffmpeg-static") || "ffmpeg",
    ffprobe: process.env.FFPROBE_PATH || tryStatic("ffprobe-static") || "ffprobe",
  };
  return cached;
}
export function setBinariesForTests(b: Binaries | null) { cached = b; }

export interface RunResult { stdout: Buffer; stderr: string }

export function runProcess(bin: string, args: string[], opts: { timeoutMs?: number; maxBuffer?: number } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { encoding: "buffer", maxBuffer: opts.maxBuffer ?? 512 * 1024 * 1024, timeout: opts.timeoutMs ?? 10 * 60_000 }, (err, stdout, stderr) => {
      const stderrText = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? "");
      if (err) {
        const tail = stderrText.split("\n").filter(Boolean).slice(-6).join(" | ");
        reject(new Error(`${path.basename(bin)} failed: ${tail || err.message}`));
        return;
      }
      resolve({ stdout: stdout as Buffer, stderr: stderrText });
    });
  });
}
