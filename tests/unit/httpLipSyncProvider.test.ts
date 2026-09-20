import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __setLookupForTests } from "@/lib/engine/safeFetch";
import { ProviderAuthError, ProviderNotConfiguredError, ProviderRequestError } from "@/lib/ai/errors/provider-errors";
import { HttpLipSyncProvider } from "@/lib/ai/providers/lipsync/http-lipsync-provider";
import type { LipSyncGenerationRequest } from "@/lib/ai/interfaces/lipsync-provider";

function baseRequest(overrides: Partial<LipSyncGenerationRequest> = {}): LipSyncGenerationRequest {
  return {
    imageBase64: "portrait-bytes",
    audioBase64: "dialogue-bytes",
    audioMimeType: "audio/mpeg",
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

describe("HttpLipSyncProvider", () => {
  beforeEach(() => {
    __setLookupForTests(async () => [{ address: "93.184.216.34", family: 4 }]); // fake vendor hostnames resolve to a public address
    process.env.LIPSYNC_PROVIDER = "test-vendor";
    process.env.LIPSYNC_PROVIDER_API_KEY = "test-key";
    process.env.LIPSYNC_PROVIDER_BASE_URL = "https://api.test-vendor.example";
    delete process.env.LIPSYNC_PROVIDER_MODEL;
    delete process.env.LIPSYNC_PROVIDER_SUBMIT_PATH;
    delete process.env.LIPSYNC_PROVIDER_STATUS_PATH;
  });

  afterEach(() => {
    __setLookupForTests(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("takes its name from LIPSYNC_PROVIDER", () => {
    expect(new HttpLipSyncProvider().name).toBe("test-vendor");
  });

  it("throws ProviderNotConfiguredError when the API key or base URL is missing", async () => {
    delete process.env.LIPSYNC_PROVIDER_API_KEY;
    const provider = new HttpLipSyncProvider();
    await expect(provider.submit(baseRequest())).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });

  it("rejects a request with neither imageBase64 nor videoBase64 before even checking configuration", async () => {
    const provider = new HttpLipSyncProvider();
    await expect(
      provider.submit({ audioBase64: "abc", audioMimeType: "audio/mpeg" }),
    ).rejects.toBeInstanceOf(ProviderRequestError);
  });

  it("submits with the image, audio, and character name", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "job-1", status: "queued" }, { ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HttpLipSyncProvider();
    const handle = await provider.submit(baseRequest({ characterName: "Akira" }));

    expect(handle).toEqual({ providerJobId: "job-1", status: "queued" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.test-vendor.example/v1/lipsync");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer test-key" });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.image).toBe("data:image/png;base64,portrait-bytes");
    expect(body.audio).toBe("data:audio/mpeg;base64,dialogue-bytes");
    expect(body.character_name).toBe("Akira");
  });

  it("submits a videoBase64 request as the video field instead of image", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "job-1", status: "queued" }, { ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HttpLipSyncProvider();
    await provider.submit(baseRequest({ imageBase64: undefined, videoBase64: "clip-bytes" }));

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.video).toBe("data:video/mp4;base64,clip-bytes");
    expect(body.image).toBeUndefined();
  });

  it("throws ProviderAuthError when submit gets a 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "unauthorized" }, { ok: false, status: 401 })),
    );
    const provider = new HttpLipSyncProvider();
    await expect(provider.submit(baseRequest())).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it("normalizes queued/processing statuses without downloading anything", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ id: "job-1", status: "in_progress" }, { ok: true, status: 200 })),
    );
    const provider = new HttpLipSyncProvider();
    const result = await provider.getStatus("job-1");
    expect(result.status).toBe("processing");
    expect(result.videoBase64).toBeUndefined();
  });

  it("downloads and base64-encodes the lip-synced clip securely on the server when status is completed", async () => {
    const videoBytes = new TextEncoder().encode("fake-mp4-bytes");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { id: "job-1", status: "completed", video_url: "https://cdn.test-vendor.example/video.mp4" },
          { ok: true, status: 200 },
        ),
      )
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => videoBytes.buffer,
      } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HttpLipSyncProvider();
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
        jsonResponse({ id: "job-1", status: "failed", error: "face not detected in reference image" }, { ok: true, status: 200 }),
      ),
    );
    const provider = new HttpLipSyncProvider();
    const result = await provider.getStatus("job-1");
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBe("face not detected in reference image");
  });

  it("propagates a network failure as ProviderRequestError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ENOTFOUND api.test-vendor.example");
      }),
    );
    const provider = new HttpLipSyncProvider();
    await expect(provider.submit(baseRequest())).rejects.toBeInstanceOf(ProviderRequestError);
  });

  describe("result-URL download security (untrusted provider output)", () => {
    const completed = (url: string) => jsonResponse({ id: "job-1", status: "completed", video_url: url }, { ok: true, status: 200 });
    const okMedia = () => ({ ok: true, status: 200, headers: new Headers({ "content-type": "video/mp4" }), arrayBuffer: async () => new TextEncoder().encode("bytes").buffer }) as unknown as Response;

    it("sends the API key when the result is served from the provider's OWN origin", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(completed("https://api.test-vendor.example/files/out.mp4")).mockResolvedValueOnce(okMedia());
      vi.stubGlobal("fetch", fetchMock);
      const result = await new HttpLipSyncProvider().getStatus("job-1");
      expect(result.status).toBe("completed");
      expect((fetchMock.mock.calls[1]![1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer test-key" });
    });

    it("REFUSES a cloud-metadata / private-IP result URL and makes no request to it", async () => {
      for (const bad of ["https://169.254.169.254/latest/meta-data/", "https://10.0.0.5/x.mp4", "https://[::1]/x.mp4", "http://cdn.test-vendor.example/x.mp4"]) {
        const fetchMock = vi.fn().mockResolvedValueOnce(completed(bad));
        vi.stubGlobal("fetch", fetchMock);
        await expect(new HttpLipSyncProvider().getStatus("job-1")).rejects.toBeInstanceOf(ProviderRequestError);
        expect(fetchMock).toHaveBeenCalledTimes(1); // only the status poll - the bad URL was never fetched
      }
    });

    it("REFUSES a public-looking hostname that resolves to a private address (DNS rebinding style)", async () => {
      __setLookupForTests(async () => [{ address: "10.1.2.3", family: 4 }]);
      const fetchMock = vi.fn().mockResolvedValueOnce(completed("https://evil.example.com/x.mp4"));
      vi.stubGlobal("fetch", fetchMock);
      await expect(new HttpLipSyncProvider().getStatus("job-1")).rejects.toBeInstanceOf(ProviderRequestError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not follow a redirect from the result URL into the internal network", async () => {
      const redirect = { ok: false, status: 302, headers: new Headers({ location: "https://169.254.169.254/latest/" }), body: null } as unknown as Response;
      const fetchMock = vi.fn().mockResolvedValueOnce(completed("https://cdn.test-vendor.example/x.mp4")).mockResolvedValueOnce(redirect);
      vi.stubGlobal("fetch", fetchMock);
      await expect(new HttpLipSyncProvider().getStatus("job-1")).rejects.toBeInstanceOf(ProviderRequestError);
      expect(fetchMock).toHaveBeenCalledTimes(2); // status poll + first hop; the metadata address is never requested
    });
  });
});
