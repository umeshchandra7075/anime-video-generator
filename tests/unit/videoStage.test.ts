import { describe, it, expect, beforeEach, vi } from "vitest";
import type { VideoProvider, VideoGenerationRequest, VideoJobResult } from "@/lib/ai/interfaces/video-provider";
import type { MediaValidationResult } from "@/lib/pipeline/ffprobe";
import type { VideoSceneInput } from "@/lib/pipeline/videoStage";

// -- In-memory stand-ins, following the same pattern as
// tests/unit/musicStageFallback.test.ts / tests/unit/voiceStage.test.ts --
const sceneAssets: Array<{
  sceneId: string;
  type: string;
  storageKey: string;
  providerName: string;
  providerJobId?: string;
  providerMetadata: string | null;
}> = [];
const sceneUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];
const uploads: Array<{ key: string; contentType: string; size: number }> = [];
const jobEvents: Array<{ jobId: string; stage: string; message: string }> = [];

vi.mock("@/lib/db", () => ({
  db: {
    sceneAsset: {
      findFirst: vi.fn(async ({ where }: { where: { sceneId: string; type: string } }) =>
        sceneAssets.find((a) => a.sceneId === where.sceneId && a.type === where.type) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: (typeof sceneAssets)[number] }) => {
        sceneAssets.push(data);
        return data;
      }),
    },
    scene: {
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        sceneUpdates.push({ id: where.id, data });
        return { id: where.id, ...data };
      }),
    },
    jobEvent: {
      create: vi.fn(async ({ data }: { data: { jobId: string; stage: string; message: string } }) => {
        jobEvents.push(data);
        return data;
      }),
    },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

vi.mock("@/lib/storage/objectStorage", () => ({
  uploadObject: vi.fn(async (key: string, body: Buffer, contentType: string) => {
    uploads.push({ key, contentType, size: body.length });
    return key;
  }),
  downloadObject: vi.fn(async () => Buffer.from("fake-reference-image-bytes")),
  projectStorageKey: (projectId: string, ...parts: string[]) => ["projects", projectId, ...parts].join("/"),
}));

const getVideoProvider = vi.fn();
const getFfmpegFallbackProvider = vi.fn();

vi.mock("@/lib/ai/factory/provider-factory", () => ({
  ProviderFactory: {
    getVideoProvider: (...args: unknown[]) => getVideoProvider(...args),
    getFfmpegFallbackProvider: (...args: unknown[]) => getFfmpegFallbackProvider(...args),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const validateFinalVideo: any = vi.fn();
vi.mock("@/lib/pipeline/ffprobe", () => ({
  validateFinalVideo: (...args: [string]) => validateFinalVideo(...args),
}));

function fakeVideoBase64() {
  return Buffer.from("fake-mp4-bytes").toString("base64");
}

function okValidation(durationSeconds: number): MediaValidationResult {
  return { ok: true, durationSeconds, hasVideoStream: true, hasAudioStream: false, method: "ffprobe" };
}

/** Records every request it was asked to submit, so tests can assert which
 * prompt/negativePrompt/characterInfo actually reached the "provider". */
function makeFakeProvider(
  name: string,
  behavior: { submitThrows?: unknown; result?: VideoJobResult } = {},
): VideoProvider & { calls: VideoGenerationRequest[] } {
  const calls: VideoGenerationRequest[] = [];
  return {
    name,
    calls,
    async submit(request: VideoGenerationRequest) {
      calls.push(request);
      if (behavior.submitThrows) throw behavior.submitThrows;
      return { providerJobId: `${name}-job-1`, status: "queued" as const };
    },
    async getStatus() {
      return (
        behavior.result ?? {
          status: "completed",
          videoBase64: fakeVideoBase64(),
          mimeType: "video/mp4",
        }
      );
    },
  };
}

describe("generateSceneVideos", () => {
  beforeEach(() => {
    sceneAssets.length = 0;
    sceneUpdates.length = 0;
    uploads.length = 0;
    jobEvents.length = 0;
    getVideoProvider.mockReset();
    getFfmpegFallbackProvider.mockReset();
    validateFinalVideo.mockReset();
    validateFinalVideo.mockResolvedValue(okValidation(6));
    delete process.env.ENABLE_FFMPEG_VIDEO_FALLBACK;
  });

  function baseScene(overrides: Partial<VideoSceneInput> = {}): VideoSceneInput {
    return {
      id: "scene-1",
      sceneNumber: 1,
      animationPrompt: "ACTION: Ren runs. MOTION: fluid anime motion.",
      animationNegativePrompt: null,
      imagePrompt: "Ren running through a forest.",
      description: "Ren runs through the forest.",
      cameraMovement: "tracking shot",
      lighting: "dappled sunlight",
      characterIds: JSON.stringify(["char-ren"]),
      estimatedSeconds: 6,
      ...overrides,
    };
  }

  it("uses the FFmpeg provider directly (no fallback attempted) when it is also the primary provider", async () => {
    const ffmpeg = makeFakeProvider("ffmpeg");
    getVideoProvider.mockReturnValue(ffmpeg);
    getFfmpegFallbackProvider.mockReturnValue(ffmpeg);

    const { generateSceneVideos } = await import("@/lib/pipeline/videoStage");
    await generateSceneVideos("proj-1", [baseScene()], "16:9", []);

    expect(ffmpeg.calls).toHaveLength(1);
    expect(sceneAssets).toHaveLength(1);
    expect(sceneAssets[0]!.providerName).toBe("ffmpeg");
    expect(uploads).toHaveLength(1);
  });

  it("uses the real AI provider when configured, and includes prompt/negativePrompt/characterInfo in the request", async () => {
    const ai = makeFakeProvider("runway");
    const ffmpeg = makeFakeProvider("ffmpeg");
    getVideoProvider.mockReturnValue(ai);
    getFfmpegFallbackProvider.mockReturnValue(ffmpeg);

    const { generateSceneVideos } = await import("@/lib/pipeline/videoStage");
    await generateSceneVideos(
      "proj-1",
      [baseScene()],
      "16:9",
      [{ id: "char-ren", name: "Ren", appearance: "teen boy", hair: "spiky black hair", clothes: "red jacket" }],
    );

    expect(ai.calls).toHaveLength(1);
    expect(ffmpeg.calls).toHaveLength(0);
    expect(ai.calls[0]!.prompt).toContain("Ren runs");
    expect(ai.calls[0]!.negativePrompt).toBeTruthy();
    expect(ai.calls[0]!.characterInfo).toContain("Ren");
    expect(sceneAssets[0]!.providerName).toBe("runway");
  });

  it("falls back to FFmpeg when the AI provider fails, and records the fallback reason", async () => {
    const ai = makeFakeProvider("runway", { submitThrows: new Error("network error: ECONNREFUSED") });
    const ffmpeg = makeFakeProvider("ffmpeg");
    getVideoProvider.mockReturnValue(ai);
    getFfmpegFallbackProvider.mockReturnValue(ffmpeg);

    const { generateSceneVideos } = await import("@/lib/pipeline/videoStage");
    await generateSceneVideos("proj-1", [baseScene()], "16:9", []);

    expect(ai.calls).toHaveLength(1);
    expect(ffmpeg.calls).toHaveLength(1);
    expect(sceneAssets[0]!.providerName).toBe("ffmpeg");
    const metadata = JSON.parse(sceneAssets[0]!.providerMetadata!);
    expect(metadata.fallbackReason).toBe("NETWORK_ERROR");
  });

  it("falls back to FFmpeg when the AI provider's clip fails FFprobe validation", async () => {
    const ai = makeFakeProvider("runway");
    const ffmpeg = makeFakeProvider("ffmpeg");
    getVideoProvider.mockReturnValue(ai);
    getFfmpegFallbackProvider.mockReturnValue(ffmpeg);
    validateFinalVideo.mockResolvedValueOnce({
      ok: false,
      reason: "output file has no video stream.",
      durationSeconds: 0,
      hasVideoStream: false,
      hasAudioStream: false,
      method: "ffprobe",
    });
    validateFinalVideo.mockResolvedValueOnce(okValidation(6)); // ffmpeg fallback's own clip validates fine

    const { generateSceneVideos } = await import("@/lib/pipeline/videoStage");
    await generateSceneVideos("proj-1", [baseScene()], "16:9", []);

    expect(ffmpeg.calls).toHaveLength(1);
    expect(sceneAssets[0]!.providerName).toBe("ffmpeg");
  });

  it("marks the scene FAILED and rethrows when both the AI provider and the FFmpeg fallback fail", async () => {
    const ai = makeFakeProvider("runway", { submitThrows: new Error("boom") });
    const ffmpeg = makeFakeProvider("ffmpeg", { submitThrows: new Error("ffmpeg also failed") });
    getVideoProvider.mockReturnValue(ai);
    getFfmpegFallbackProvider.mockReturnValue(ffmpeg);

    const { generateSceneVideos } = await import("@/lib/pipeline/videoStage");
    await expect(generateSceneVideos("proj-1", [baseScene()], "16:9", [])).rejects.toThrow("ffmpeg also failed");

    expect(sceneAssets).toHaveLength(0);
    const failedUpdate = sceneUpdates.find((u) => u.data.status === "FAILED");
    expect(failedUpdate).toBeTruthy();
  });

  it("does not fall back when ENABLE_FFMPEG_VIDEO_FALLBACK=false - the AI provider's error propagates directly", async () => {
    process.env.ENABLE_FFMPEG_VIDEO_FALLBACK = "false";
    const ai = makeFakeProvider("runway", { submitThrows: new Error("strict mode failure") });
    const ffmpeg = makeFakeProvider("ffmpeg");
    getVideoProvider.mockReturnValue(ai);
    getFfmpegFallbackProvider.mockReturnValue(ffmpeg);

    const { generateSceneVideos } = await import("@/lib/pipeline/videoStage");
    await expect(generateSceneVideos("proj-1", [baseScene()], "16:9", [])).rejects.toThrow("strict mode failure");

    expect(ffmpeg.calls).toHaveLength(0);
  });

  it("updates the scene's estimatedSeconds when the AI provider's validated clip duration drifts from the plan", async () => {
    const ai = makeFakeProvider("runway");
    const ffmpeg = makeFakeProvider("ffmpeg");
    getVideoProvider.mockReturnValue(ai);
    getFfmpegFallbackProvider.mockReturnValue(ffmpeg);
    validateFinalVideo.mockResolvedValue(okValidation(10)); // provider ignored the requested 6s and returned 10s

    const { generateSceneVideos } = await import("@/lib/pipeline/videoStage");
    await generateSceneVideos("proj-1", [baseScene({ estimatedSeconds: 6 })], "16:9", []);

    const completionUpdate = sceneUpdates.find((u) => u.data.status === "COMPLETED");
    expect(completionUpdate?.data.estimatedSeconds).toBe(10);
  });

  it("AUDIO-FIRST: does NOT overwrite estimatedSeconds when the scene already has a master timeline (the renderer holds/trims the clip instead)", async () => {
    const ai = makeFakeProvider("runway");
    const ffmpeg = makeFakeProvider("ffmpeg");
    getVideoProvider.mockReturnValue(ai);
    getFfmpegFallbackProvider.mockReturnValue(ffmpeg);
    validateFinalVideo.mockResolvedValue(okValidation(10)); // provider returned 10s, but the audio needs exactly 6s

    const { generateSceneVideos } = await import("@/lib/pipeline/videoStage");
    await generateSceneVideos("proj-1", [baseScene({ estimatedSeconds: 6, hasTimeline: true })], "16:9", []);

    const completionUpdate = sceneUpdates.find((u) => u.data.status === "COMPLETED");
    expect(completionUpdate?.data.estimatedSeconds).toBeUndefined();
  });

  it("does not touch estimatedSeconds when the ffmpeg fallback is used (it always renders the exact requested duration)", async () => {
    const ffmpeg = makeFakeProvider("ffmpeg");
    getVideoProvider.mockReturnValue(ffmpeg);
    getFfmpegFallbackProvider.mockReturnValue(ffmpeg);
    validateFinalVideo.mockResolvedValue(okValidation(999)); // even if validation reports something odd

    const { generateSceneVideos } = await import("@/lib/pipeline/videoStage");
    await generateSceneVideos("proj-1", [baseScene({ estimatedSeconds: 6 })], "16:9", []);

    const completionUpdate = sceneUpdates.find((u) => u.data.status === "COMPLETED");
    expect(completionUpdate?.data.estimatedSeconds).toBeUndefined();
  });

  it("is idempotent: skips scenes that already have a VIDEO_CLIP asset, without calling any provider", async () => {
    sceneAssets.push({
      sceneId: "scene-1",
      type: "VIDEO_CLIP",
      storageKey: "already-there.mp4",
      providerName: "runway",
      providerMetadata: null,
    });
    const ai = makeFakeProvider("runway");
    const ffmpeg = makeFakeProvider("ffmpeg");
    getVideoProvider.mockReturnValue(ai);
    getFfmpegFallbackProvider.mockReturnValue(ffmpeg);

    const { generateSceneVideos } = await import("@/lib/pipeline/videoStage");
    await generateSceneVideos("proj-1", [baseScene()], "16:9", []);

    expect(ai.calls).toHaveLength(0);
    expect(ffmpeg.calls).toHaveLength(0);
    expect(sceneAssets).toHaveLength(1); // unchanged
  });

  it("logs a job event when falling back, if a jobId is provided", async () => {
    const ai = makeFakeProvider("runway", { submitThrows: new Error("boom") });
    const ffmpeg = makeFakeProvider("ffmpeg");
    getVideoProvider.mockReturnValue(ai);
    getFfmpegFallbackProvider.mockReturnValue(ffmpeg);

    const { generateSceneVideos } = await import("@/lib/pipeline/videoStage");
    await generateSceneVideos("proj-1", [baseScene()], "16:9", [], "job-123");

    expect(jobEvents.length).toBeGreaterThan(0);
    expect(jobEvents.every((e) => e.jobId === "job-123")).toBe(true);
  });
});
