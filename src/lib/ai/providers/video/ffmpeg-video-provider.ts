import {
  VideoProvider,
  VideoGenerationRequest,
  VideoJobHandle,
  VideoJobResult,
} from "@/lib/ai/interfaces/video-provider";
import ffmpegPath from "ffmpeg-static";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";

const execFileAsync = promisify(execFile);

// Finished jobs carry the whole clip as base64, so this store must be bounded: entries expire and the oldest are
// evicted, otherwise a long-running worker leaks megabytes per fallback scene.
const JOB_TTL_MS = 15 * 60 * 1000;
const JOB_MAX_ENTRIES = 16;
const jobStore = new Map<string, { at: number; result: VideoJobResult }>();
const jobs = {
  set(id: string, result: VideoJobResult) {
    const now = Date.now();
    jobStore.delete(id);
    jobStore.set(id, { at: now, result });
    for (const [k, v] of jobStore) if (now - v.at > JOB_TTL_MS) jobStore.delete(k);
    while (jobStore.size > JOB_MAX_ENTRIES) jobStore.delete(jobStore.keys().next().value as string);
  },
  get(id: string): VideoJobResult | undefined {
    const e = jobStore.get(id);
    if (!e) return undefined;
    if (Date.now() - e.at > JOB_TTL_MS) { jobStore.delete(id); return undefined; }
    return e.result;
  },
};

export class FfmpegVideoProvider implements VideoProvider {
  readonly name = "ffmpeg";

  async submit(
    request: VideoGenerationRequest
  ): Promise<VideoJobHandle> {
    if (!ffmpegPath) {
      throw new Error("FFmpeg executable was not found.");
    }

    if (!request.referenceImageBase64) {
      throw new Error(
        "A reference image is required for FFmpeg animation."
      );
    }

    const jobId = randomUUID();

    jobs.set(jobId, {
      status: "processing",
    });

    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "anime-video-")
    );

    const imagePath = path.join(tempDir, "scene.png");
    const videoPath = path.join(tempDir, "scene.mp4");

    try {
      const imageBuffer = Buffer.from(
        request.referenceImageBase64,
        "base64"
      );

      await fs.writeFile(imagePath, imageBuffer);

      const duration = Math.max(
        1,
        request.durationSeconds
      );

      const { width, height } =
        this.getDimensions(request.aspectRatio);

      await execFileAsync(ffmpegPath, [
        "-y",

        "-loop",
        "1",

        "-i",
        imagePath,

        "-t",
        String(duration),

        "-vf",
        `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
          `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,` +
          `zoompan=z='min(zoom+0.0015,1.12)':` +
          `x='iw/2-(iw/zoom/2)':` +
          `y='ih/2-(ih/zoom/2)':` +
          `d=1:s=${width}x${height}:fps=30`,

        "-c:v",
        "libx264",

        "-preset",
        "veryfast",

        "-pix_fmt",
        "yuv420p",

        "-movflags",
        "+faststart",

        videoPath,
      ]);

      const videoBuffer = await fs.readFile(
        videoPath
      );

      const videoBase64 =
        videoBuffer.toString("base64");

      jobs.set(jobId, {
        status: "completed",
        videoBase64,
        mimeType: "video/mp4",
        providerMetadata: {
          provider: "ffmpeg",
          width,
          height,
          durationSeconds: duration,
          animation: "ken-burns-zoom",
        },
      });

      return {
        providerJobId: jobId,
        status: "completed",
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "FFmpeg video generation failed.";

      jobs.set(jobId, {
        status: "failed",
        errorMessage: message,
      });

      throw error;
    } finally {
      await fs.rm(tempDir, {
        recursive: true,
        force: true,
      });
    }
  }

  async getStatus(
    providerJobId: string
  ): Promise<VideoJobResult> {
    const result = jobs.get(providerJobId);

    if (!result) {
      return {
        status: "failed",
        errorMessage: "FFmpeg job was not found.",
      };
    }

    return result;
  }

  async cancel(
    providerJobId: string
  ): Promise<void> {
    jobs.set(providerJobId, {
      status: "cancelled",
    });
  }

  private getDimensions(
    aspectRatio: VideoGenerationRequest["aspectRatio"]
  ): {
    width: number;
    height: number;
  } {
    switch (aspectRatio) {
      case "9:16":
        return {
          width: 720,
          height: 1280,
        };

      case "1:1":
        return {
          width: 1080,
          height: 1080,
        };

      case "16:9":
      default:
        return {
          width: 1280,
          height: 720,
        };
    }
  }
}