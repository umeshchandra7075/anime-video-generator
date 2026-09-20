import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import os from "os";
import path from "path";
import ffmpegPath from "ffmpeg-static";
import {
  resolveFfprobePath,
  resolveFfmpegPath,
  probeWithFfprobe,
  probeWithFfmpegFallback,
  validateFinalVideo,
} from "@/lib/pipeline/ffprobe";

const execFileAsync = promisify(execFile);

/**
 * These tests exercise the *real* local ffprobe-static / ffmpeg-static
 * binaries (no mocking of child_process) against real, small MP4 files
 * generated on the fly with ffmpeg's `lavfi` test sources - so a passing
 * suite means the actual final-rendering validation path works end to end,
 * not just that some mock was called correctly.
 */

let workDir: string;
let validMp4Path: string;
let dirWithSpacePath: string;

async function generateTestMp4(outPath: string, durationSeconds = 1): Promise<void> {
  if (!ffmpegPath) throw new Error("ffmpeg-static did not resolve a path - cannot build test fixtures.");
  const args = [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=64x64:rate=10:duration=${durationSeconds}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${durationSeconds}`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    outPath,
  ];
  await execFileAsync(ffmpegPath, args, { timeout: 30_000 });
}

beforeAll(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "ffprobe-test-"));
  validMp4Path = path.join(workDir, "valid.mp4");
  await generateTestMp4(validMp4Path);

  // Simulates a Windows path containing spaces, e.g.
  // "C:\Users\umesh chandra\Downloads\...". We can't create a literal
  // Windows path on this (non-Windows) test host, but we *can* prove the
  // array-based execFile calls in ffprobe.ts handle a directory name with
  // spaces correctly, which is exactly the mechanism that makes Windows
  // paths-with-spaces safe (Node never builds a shell string from these
  // arguments, on any OS).
  dirWithSpacePath = path.join(workDir, "umesh chandra", "Downloads (final) - video");
  await fs.mkdir(dirWithSpacePath, { recursive: true });
});

afterAll(async () => {
  await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
});

describe("resolveFfprobePath / resolveFfmpegPath", () => {
  it("resolves the ffprobe binary from the local ffprobe-static package, not a global install", () => {
    const p = resolveFfprobePath();
    expect(p).toBeTruthy();
    expect(p).toContain(`${path.sep}node_modules${path.sep}ffprobe-static${path.sep}`);
  });

  it("resolves the ffmpeg binary from the local ffmpeg-static package", () => {
    const p = resolveFfmpegPath();
    expect(p).toBeTruthy();
    expect(p).toContain(`${path.sep}node_modules${path.sep}ffmpeg-static${path.sep}`);
  });

  it("bundles a Windows (win32) ffprobe.exe binary alongside the current platform's binary", async () => {
    const bin = resolveFfprobePath();
    expect(bin).toBeTruthy();
    // node_modules/ffprobe-static/bin/<platform>/<arch>/ffprobe[.exe]
    const staticRoot = bin!.split(`${path.sep}bin${path.sep}`)[0] ?? "";
    const win32x64 = path.join(staticRoot, "bin", "win32", "x64", "ffprobe.exe");
    const stat = await fs.stat(win32x64);
    expect(stat.isFile()).toBe(true);
  });
});

describe("probeWithFfprobe", () => {
  it("reads duration and stream types from a valid MP4 using only the local binary", async () => {
    const info = await probeWithFfprobe(validMp4Path);
    expect(info.hasVideoStream).toBe(true);
    expect(info.hasAudioStream).toBe(true);
    expect(info.durationSeconds).toBeGreaterThan(0);
  });

  it("works with a Windows-style path containing spaces (via array-form execFile args)", async () => {
    const spacedPath = path.join(dirWithSpacePath, "final output.mp4");
    await generateTestMp4(spacedPath);
    const info = await probeWithFfprobe(spacedPath);
    expect(info.hasVideoStream).toBe(true);
    expect(info.durationSeconds).toBeGreaterThan(0);
  });

  it("never depends on a global/PATH ffprobe install", async () => {
    const originalPath = process.env.PATH;
    try {
      // Blank out PATH entirely - if this module ever shelled out to a bare
      // "ffprobe" command (relying on PATH lookup), this would break it.
      // Since it always calls an absolute path, it must keep working.
      process.env.PATH = "";
      const info = await probeWithFfprobe(validMp4Path);
      expect(info.hasVideoStream).toBe(true);
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
  });

  it("rejects a missing file", async () => {
    await expect(probeWithFfprobe(path.join(workDir, "does-not-exist.mp4"))).rejects.toThrow();
  });

  it("rejects an invalid (non-media) file", async () => {
    const invalidPath = path.join(workDir, "invalid.mp4");
    await fs.writeFile(invalidPath, "this is not a real video file, just plain text");
    await expect(probeWithFfprobe(invalidPath)).rejects.toThrow();
  });
});

describe("probeWithFfmpegFallback", () => {
  it("independently confirms duration/streams for a valid MP4 using only the local ffmpeg binary", async () => {
    const info = await probeWithFfmpegFallback(validMp4Path);
    expect(info.hasVideoStream).toBe(true);
    expect(info.hasAudioStream).toBe(true);
    expect(info.durationSeconds).toBeGreaterThan(0);
  });

  it("throws for a file with no readable media content", async () => {
    const invalidPath = path.join(workDir, "invalid-fallback.mp4");
    await fs.writeFile(invalidPath, Buffer.from([0x00, 0x01, 0x02, 0x03]));
    await expect(probeWithFfmpegFallback(invalidPath)).rejects.toThrow();
  });
});

describe("validateFinalVideo (the function compositeStage.ts calls)", () => {
  it("accepts a real, valid rendered MP4", async () => {
    const result = await validateFinalVideo(validMp4Path);
    expect(result.ok).toBe(true);
    expect(result.hasVideoStream).toBe(true);
    expect(result.durationSeconds).toBeGreaterThan(0);
    expect(result.method).toBe("ffprobe");
  });

  it("rejects a missing output file without throwing", async () => {
    const result = await validateFinalVideo(path.join(workDir, "missing-output.mp4"));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/does not exist/i);
  });

  it("rejects an empty output file", async () => {
    const emptyPath = path.join(workDir, "empty.mp4");
    await fs.writeFile(emptyPath, Buffer.alloc(0));
    const result = await validateFinalVideo(emptyPath);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/empty/i);
  });

  it("rejects an invalid (corrupt/non-media) output file", async () => {
    const invalidPath = path.join(workDir, "corrupt-output.mp4");
    await fs.writeFile(invalidPath, "not a video");
    const result = await validateFinalVideo(invalidPath);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("validates a Windows-style path with spaces end to end", async () => {
    const spacedPath = path.join(dirWithSpacePath, "final validated output.mp4");
    await generateTestMp4(spacedPath);
    const result = await validateFinalVideo(spacedPath);
    expect(result.ok).toBe(true);
    expect(result.durationSeconds).toBeGreaterThan(0);
  });
});
