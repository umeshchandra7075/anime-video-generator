import { describe, it, expect, beforeEach, vi } from "vitest";
import { ProviderRequestError, ProviderNotConfiguredError } from "@/lib/ai/errors/provider-errors";
import type { MusicProvider, MusicGenerationRequest, MusicJobHandle, MusicJobResult } from "@/lib/ai/interfaces/music-provider";

// In-memory stand-ins for the pieces musicStage.ts talks to, so this test
// exercises the *actual* fallback control flow in musicStage.ts without a
// real database or real ffmpeg subprocess.
const audioAssets: Array<{ projectId: string; type: string; storageKey: string; providerName: string; providerMetadata: string | null }> = [];
const jobEvents: Array<{ jobId: string; stage: string; message: string | null }> = [];
const uploads: Array<{ key: string; contentType: string; size: number }> = [];

vi.mock("@/lib/db", () => ({
  db: {
    audioAsset: {
      findFirst: vi.fn(async ({ where }: { where: { projectId: string; type: string } }) =>
        audioAssets.find((a) => a.projectId === where.projectId && a.type === where.type) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: (typeof audioAssets)[number] }) => {
        audioAssets.push(data);
        return data;
      }),
    },
    jobEvent: {
      create: vi.fn(async ({ data }: { data: (typeof jobEvents)[number] }) => {
        jobEvents.push(data);
        return data;
      }),
    },
  },
}));

vi.mock("@/lib/storage/objectStorage", () => ({
  uploadObject: vi.fn(async (key: string, body: Buffer, contentType: string) => {
    uploads.push({ key, contentType, size: body.length });
    return key;
  }),
  projectStorageKey: (projectId: string, ...parts: string[]) => ["projects", projectId, ...parts].join("/"),
}));

function fakeAudioBase64() {
  return Buffer.from("fake-mp3-bytes").toString("base64");
}

/** A MusicProvider test double whose submit() either succeeds immediately
 * or throws the given error, mirroring the real providers' synchronous
 * (already-resolved) job pattern. */
function makeProvider(name: string, behavior: { throws?: unknown } = {}): MusicProvider {
  const jobs = new Map<string, MusicJobResult>();
  return {
    name,
    async submit(_request: MusicGenerationRequest): Promise<MusicJobHandle> {
      if (behavior.throws) throw behavior.throws;
      const id = `${name}-job`;
      jobs.set(id, {
        status: "completed",
        audioBase64: fakeAudioBase64(),
        mimeType: "audio/mpeg",
        providerMetadata: { provider: name },
      });
      return { providerJobId: id, status: "completed" };
    },
    async getStatus(providerJobId: string): Promise<MusicJobResult> {
      return jobs.get(providerJobId) ?? { status: "failed", errorMessage: "not found" };
    },
  };
}

const getMusicProvider = vi.fn();
const getLocalAudioFallbackProvider = vi.fn();

vi.mock("@/lib/ai/factory/provider-factory", () => ({
  ProviderFactory: {
    getMusicProvider: (...args: unknown[]) => getMusicProvider(...args),
    getLocalAudioFallbackProvider: (...args: unknown[]) => getLocalAudioFallbackProvider(...args),
  },
}));

describe("generateProjectMusic - local FFmpeg fallback", () => {
  beforeEach(() => {
    audioAssets.length = 0;
    jobEvents.length = 0;
    uploads.length = 0;
    getMusicProvider.mockReset();
    getLocalAudioFallbackProvider.mockReset();
    delete process.env.ENABLE_LOCAL_AUDIO_FALLBACK;
  });

  it("uses the primary provider when it succeeds, with no fallback metadata", async () => {
    getMusicProvider.mockReturnValue(makeProvider("pollinations"));
    getLocalAudioFallbackProvider.mockReturnValue(makeProvider("local-ffmpeg-fallback"));

    const { generateProjectMusic } = await import("@/lib/pipeline/musicStage");
    await generateProjectMusic("proj-1", "cinematic", 30, "job-1");

    expect(audioAssets).toHaveLength(1);
    expect(audioAssets[0]!.providerName).toBe("pollinations");
    const metadata = JSON.parse(audioAssets[0]!.providerMetadata!);
    expect(metadata.fallbackReason).toBeUndefined();
    expect(uploads).toHaveLength(1);
  });

  it("falls back to local audio on a 402 INSUFFICIENT_BALANCE error and never throws", async () => {
    const insufficientBalance = new ProviderRequestError(
      "pollinations",
      'Pollinations audio generation failed (402): INSUFFICIENT_BALANCE - "This request costs ~$0.0401, but your available paid balance is $0.0000."',
      402,
    );
    getMusicProvider.mockReturnValue(makeProvider("pollinations", { throws: insufficientBalance }));
    getLocalAudioFallbackProvider.mockReturnValue(makeProvider("local-ffmpeg-fallback"));

    const { generateProjectMusic } = await import("@/lib/pipeline/musicStage");
    await expect(generateProjectMusic("proj-2", "cinematic", 30, "job-2")).resolves.toBeUndefined();

    expect(audioAssets).toHaveLength(1);
    expect(audioAssets[0]!.providerName).toBe("local-ffmpeg-fallback");
    const metadata = JSON.parse(audioAssets[0]!.providerMetadata!);
    expect(metadata.fallbackReason).toBe("INSUFFICIENT_BALANCE");
    expect(metadata.provider).toBe("local-ffmpeg-fallback");

    // A job event should record the fallback for the progress UI/logs.
    expect(jobEvents.some((e) => e.message?.includes("INSUFFICIENT_BALANCE"))).toBe(true);
  });

  it("falls back to local audio when the API key is missing (ProviderNotConfiguredError)", async () => {
    getMusicProvider.mockReturnValue(
      makeProvider("pollinations", { throws: new ProviderNotConfiguredError("pollinations-music") }),
    );
    getLocalAudioFallbackProvider.mockReturnValue(makeProvider("local-ffmpeg-fallback"));

    const { generateProjectMusic } = await import("@/lib/pipeline/musicStage");
    await generateProjectMusic("proj-3", "action", 20, "job-3");

    expect(audioAssets[0]!.providerName).toBe("local-ffmpeg-fallback");
    const metadata = JSON.parse(audioAssets[0]!.providerMetadata!);
    expect(metadata.fallbackReason).toBe("PROVIDER_NOT_CONFIGURED");
  });

  it.each([401, 403, 429, 500, 503])("falls back to local audio on HTTP %i", async (status) => {
    getMusicProvider.mockReturnValue(
      makeProvider("pollinations", { throws: new ProviderRequestError("pollinations", `failed (${status})`, status) }),
    );
    getLocalAudioFallbackProvider.mockReturnValue(makeProvider("local-ffmpeg-fallback"));

    const { generateProjectMusic } = await import("@/lib/pipeline/musicStage");
    await generateProjectMusic(`proj-status-${status}`, "horror", 15, `job-status-${status}`);

    const asset = audioAssets.find((a) => a.projectId === `proj-status-${status}`);
    expect(asset?.providerName).toBe("local-ffmpeg-fallback");
  });

  it("falls back on a network error / timeout (generic Error, no status code)", async () => {
    getMusicProvider.mockReturnValue(
      makeProvider("pollinations", { throws: new Error("fetch failed: ENOTFOUND gen.pollinations.ai") }),
    );
    getLocalAudioFallbackProvider.mockReturnValue(makeProvider("local-ffmpeg-fallback"));

    const { generateProjectMusic } = await import("@/lib/pipeline/musicStage");
    await generateProjectMusic("proj-network", "mystery", 25, "job-network");

    expect(audioAssets[0]!.providerName).toBe("local-ffmpeg-fallback");
  });

  it("does not create an AudioAsset and does not throw if even the local fallback fails", async () => {
    getMusicProvider.mockReturnValue(
      makeProvider("pollinations", { throws: new ProviderRequestError("pollinations", "failed (402)", 402) }),
    );
    getLocalAudioFallbackProvider.mockReturnValue(
      makeProvider("local-ffmpeg-fallback", { throws: new Error("ffmpeg binary missing") }),
    );

    const { generateProjectMusic } = await import("@/lib/pipeline/musicStage");
    await expect(generateProjectMusic("proj-both-fail", "romantic", 10, "job-both-fail")).resolves.toBeUndefined();

    expect(audioAssets.find((a) => a.projectId === "proj-both-fail")).toBeUndefined();
    expect(jobEvents.some((e) => e.message?.includes("continuing without background music"))).toBe(true);
  });

  it("preserves the old behavior (throws) when ENABLE_LOCAL_AUDIO_FALLBACK=false", async () => {
    process.env.ENABLE_LOCAL_AUDIO_FALLBACK = "false";
    const err = new ProviderRequestError("pollinations", "failed (402)", 402);
    getMusicProvider.mockReturnValue(makeProvider("pollinations", { throws: err }));
    getLocalAudioFallbackProvider.mockReturnValue(makeProvider("local-ffmpeg-fallback"));

    const { generateProjectMusic } = await import("@/lib/pipeline/musicStage");
    await expect(generateProjectMusic("proj-disabled", "cinematic", 10, "job-disabled")).rejects.toBe(err);
    expect(audioAssets.find((a) => a.projectId === "proj-disabled")).toBeUndefined();
  });

  it("skips entirely when mood is 'none', calling no provider", async () => {
    getMusicProvider.mockReturnValue(makeProvider("pollinations"));
    getLocalAudioFallbackProvider.mockReturnValue(makeProvider("local-ffmpeg-fallback"));

    const { generateProjectMusic } = await import("@/lib/pipeline/musicStage");
    await generateProjectMusic("proj-none", "none", 10, "job-none");

    expect(audioAssets.find((a) => a.projectId === "proj-none")).toBeUndefined();
    expect(getMusicProvider).not.toHaveBeenCalled();
  });

  it("is idempotent: does nothing if a MUSIC asset already exists for the project", async () => {
    audioAssets.push({
      projectId: "proj-existing",
      type: "MUSIC",
      storageKey: "already-there.mp3",
      providerName: "pollinations",
      providerMetadata: null,
    });
    getMusicProvider.mockReturnValue(makeProvider("pollinations"));
    getLocalAudioFallbackProvider.mockReturnValue(makeProvider("local-ffmpeg-fallback"));

    const { generateProjectMusic } = await import("@/lib/pipeline/musicStage");
    await generateProjectMusic("proj-existing", "cinematic", 10, "job-existing");

    expect(audioAssets).toHaveLength(1); // unchanged
    expect(getMusicProvider).not.toHaveBeenCalled();
  });
});
