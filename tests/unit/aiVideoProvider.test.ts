import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __setLookupForTests } from "@/lib/engine/safeFetch";
import { ProviderAuthError, ProviderNotConfiguredError, ProviderRequestError } from "@/lib/ai/errors/provider-errors";
import { HttpVideoProvider } from "@/lib/ai/providers/video/ai-video-provider";
import type { VideoGenerationRequest } from "@/lib/ai/interfaces/video-provider";

function baseRequest(overrides: Partial<VideoGenerationRequest> = {}): VideoGenerationRequest {
  return {
    prompt: "ACTION: Ren runs through the forest.",
    durationSeconds: 6,
    aspectRatio: "16:9",
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: Partial<Response> & { ok: boolean; status: number }) {
  return {
    ...init,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("HttpVideoProvider", () => {
  beforeEach(() => {
    __setLookupForTests(async () => [{ address: "93.184.216.34", family: 4 }]); // fake vendor hostnames resolve to a public address
    process.env.VIDEO_PROVIDER = "test-vendor";
    process.env.VIDEO_PROVIDER_API_KEY = "test-key";
    process.env.VIDEO_PROVIDER_BASE_URL = "https://api.test-vendor.example";
    delete process.env.VIDEO_PROVIDER_MODEL;
    delete process.env.VIDEO_PROVIDER_SUBMIT_PATH;
    delete process.env.VIDEO_PROVIDER_STATUS_PATH;
  });

  afterEach(() => {
    __setLookupForTests(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("takes its name from VIDEO_PROVIDER", () => {
    expect(new HttpVideoProvider().name).toBe("test-vendor");
  });

  it("throws ProviderNotConfiguredError when the API key or base URL is missing", async () => {
    delete process.env.VIDEO_PROVIDER_API_KEY;
    const provider = new HttpVideoProvider();
    await expect(provider.submit(baseRequest())).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });

  it("submits with the prompt, duration, aspect ratio, negative prompt, and reference image", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "job-1", status: "queued" }, { ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HttpVideoProvider();
    const handle = await provider.submit(
      baseRequest({ negativePrompt: "extra limbs, jump cuts", referenceImageBase64: "abc123", characterInfo: "Ren (teen boy)" }),
    );

    expect(handle).toEqual({ providerJobId: "job-1", status: "queued" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.test-vendor.example/v1/videos");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer test-key" });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.prompt).toContain("Ren runs");
    expect(body.negative_prompt).toBe("extra limbs, jump cuts");
    expect(body.character_context).toBe("Ren (teen boy)");
    expect(body.image).toBe("data:image/png;base64,abc123");
    expect(body.duration_seconds).toBe(6);
    expect(body.aspect_ratio).toBe("16:9");
  });

  it("throws ProviderAuthError when submit gets a 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "unauthorized" }, { ok: false, status: 401 })),
    );
    const provider = new HttpVideoProvider();
    await expect(provider.submit(baseRequest())).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it("throws ProviderRequestError when submit fails with a server error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "boom" }, { ok: false, status: 500 })),
    );
    const provider = new HttpVideoProvider();
    await expect(provider.submit(baseRequest())).rejects.toBeInstanceOf(ProviderRequestError);
  });

  it("normalizes queued/processing statuses without downloading anything", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ id: "job-1", status: "in_progress" }, { ok: true, status: 200 })),
    );
    const provider = new HttpVideoProvider();
    const result = await provider.getStatus("job-1");
    expect(result.status).toBe("processing");
    expect(result.videoBase64).toBeUndefined();
  });

  it("downloads and base64-encodes the video securely on the server when status is completed", async () => {
    const videoBytes = new TextEncoder().encode("fake-mp4-bytes");
    const fetchMock = vi
      .fn()
      // 1st call: status poll
      .mockResolvedValueOnce(
        jsonResponse({ id: "job-1", status: "completed", video_url: "https://cdn.test-vendor.example/video.mp4" }, {
          ok: true,
          status: 200,
        }),
      )
      // 2nd call: downloading the video itself
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => videoBytes.buffer,
      } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HttpVideoProvider();
    const result = await provider.getStatus("job-1");

    expect(result.status).toBe("completed");
    expect(result.mimeType).toBe("video/mp4");
    expect(Buffer.from(result.videoBase64!, "base64").toString()).toBe("fake-mp4-bytes");
    // SECURITY: the result lives on a DIFFERENT origin (cdn.test-vendor.example) than the API
    // (api.test-vendor.example), so the provider API key must NOT be sent to it.
    const [, downloadInit] = fetchMock.mock.calls[1]!;
    expect(JSON.stringify((downloadInit as RequestInit).headers ?? {})).not.toContain("test-key");
  });

  it("reports a failed job with the provider's error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ id: "job-1", status: "failed", error: "content policy violation" }, { ok: true, status: 200 }),
      ),
    );
    const provider = new HttpVideoProvider();
    const result = await provider.getStatus("job-1");
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBe("content policy violation");
  });

  it("propagates a network failure as ProviderRequestError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ENOTFOUND api.test-vendor.example");
      }),
    );
    const provider = new HttpVideoProvider();
    await expect(provider.submit(baseRequest())).rejects.toBeInstanceOf(ProviderRequestError);
  });

  describe("result-URL download security (untrusted provider output)", () => {
    const completed = (url: string) => jsonResponse({ id: "job-1", status: "completed", video_url: url }, { ok: true, status: 200 });
    const okMedia = () => ({ ok: true, status: 200, headers: new Headers({ "content-type": "video/mp4" }), arrayBuffer: async () => new TextEncoder().encode("bytes").buffer }) as unknown as Response;

    it("sends the API key when the result is served from the provider's OWN origin", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(completed("https://api.test-vendor.example/files/out.mp4")).mockResolvedValueOnce(okMedia());
      vi.stubGlobal("fetch", fetchMock);
      const result = await new HttpVideoProvider().getStatus("job-1");
      expect(result.status).toBe("completed");
      expect((fetchMock.mock.calls[1]![1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer test-key" });
    });

    it("REFUSES a cloud-metadata / private-IP result URL and makes no request to it", async () => {
      for (const bad of ["https://169.254.169.254/latest/meta-data/", "https://10.0.0.5/x.mp4", "https://[::1]/x.mp4", "http://cdn.test-vendor.example/x.mp4"]) {
        const fetchMock = vi.fn().mockResolvedValueOnce(completed(bad));
        vi.stubGlobal("fetch", fetchMock);
        await expect(new HttpVideoProvider().getStatus("job-1")).rejects.toBeInstanceOf(ProviderRequestError);
        expect(fetchMock).toHaveBeenCalledTimes(1); // only the status poll - the bad URL was never fetched
      }
    });

    it("REFUSES a public-looking hostname that resolves to a private address (DNS rebinding style)", async () => {
      __setLookupForTests(async () => [{ address: "10.1.2.3", family: 4 }]);
      const fetchMock = vi.fn().mockResolvedValueOnce(completed("https://evil.example.com/x.mp4"));
      vi.stubGlobal("fetch", fetchMock);
      await expect(new HttpVideoProvider().getStatus("job-1")).rejects.toBeInstanceOf(ProviderRequestError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not follow a redirect from the result URL into the internal network", async () => {
      const redirect = { ok: false, status: 302, headers: new Headers({ location: "https://169.254.169.254/latest/" }), body: null } as unknown as Response;
      const fetchMock = vi.fn().mockResolvedValueOnce(completed("https://cdn.test-vendor.example/x.mp4")).mockResolvedValueOnce(redirect);
      vi.stubGlobal("fetch", fetchMock);
      await expect(new HttpVideoProvider().getStatus("job-1")).rejects.toBeInstanceOf(ProviderRequestError);
      expect(fetchMock).toHaveBeenCalledTimes(2); // status poll + first hop; the metadata address is never requested
    });
  });
});
