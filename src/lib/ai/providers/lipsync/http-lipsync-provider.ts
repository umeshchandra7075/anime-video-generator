import {
  LipSyncProvider,
  LipSyncGenerationRequest,
  LipSyncJobHandle,
  LipSyncJobResult,
} from "@/lib/ai/interfaces/lipsync-provider";
import { ProviderJobStatus } from "@/lib/ai/interfaces/video-provider";
import { downloadProviderMedia } from "@/lib/ai/providers/mediaDownload";
import { ProviderAuthError, ProviderNotConfiguredError, ProviderRequestError } from "@/lib/ai/errors/provider-errors";

/**
 * Configurable adapter for a real audio-driven lip-sync / talking-avatar
 * API - sync.so, D-ID, HeyGen, and hosted Wav2Lip/SadTalker-style services
 * all follow the same shape: submit a face (image or video) plus an audio
 * track, poll a status endpoint until it's done, then download the
 * finished MP4 from a URL. Mirrors HttpVideoProvider
 * (src/lib/ai/providers/video/ai-video-provider.ts) exactly, since there is
 * likewise no single universal lip-sync API - every field name below is
 * configurable through environment variables so this can be pointed at
 * whichever vendor is actually plugged in:
 *
 *   LIPSYNC_PROVIDER               - a short tag identifying the vendor,
 *                                     used for logging and
 *                                     SceneAsset.providerName (e.g. "syncso",
 *                                     "did", "heygen").
 *   LIPSYNC_PROVIDER_API_KEY        - bearer token / API key (required).
 *   LIPSYNC_PROVIDER_BASE_URL       - e.g. https://api.vendor.com (required).
 *   LIPSYNC_PROVIDER_MODEL          - optional model id sent in the request body.
 *   LIPSYNC_PROVIDER_SUBMIT_PATH    - default "/v1/lipsync".
 *   LIPSYNC_PROVIDER_STATUS_PATH    - default "/v1/lipsync/{id}" ("{id}" is
 *                                     substituted with the job id returned by
 *                                     the submit call).
 *
 * If your chosen vendor's JSON field names differ from the ones this
 * adapter sends/expects (very likely - every vendor's API is slightly
 * different), adjust `buildSubmitBody` and `parseStatusResponse` below to
 * match their actual contract. Everything else (auth header, polling
 * integration, error mapping, secure server-side download) stays the same
 * regardless of vendor.
 */
export class HttpLipSyncProvider implements LipSyncProvider {
  readonly name: string;

  constructor() {
    this.name = (process.env.LIPSYNC_PROVIDER || "").trim() || "ai-lipsync";
  }

  private getConfig(): { apiKey: string; baseUrl: string; model?: string } {
    const apiKey = process.env.LIPSYNC_PROVIDER_API_KEY;
    const baseUrl = process.env.LIPSYNC_PROVIDER_BASE_URL;
    if (!apiKey || !baseUrl) {
      throw new ProviderNotConfiguredError(this.name);
    }
    return { apiKey, baseUrl: baseUrl.replace(/\/+$/, ""), model: process.env.LIPSYNC_PROVIDER_MODEL };
  }

  async submit(request: LipSyncGenerationRequest): Promise<LipSyncJobHandle> {
    if (!request.imageBase64 && !request.videoBase64) {
      throw new ProviderRequestError(this.name, "Lip-sync request needs either imageBase64 or videoBase64.");
    }

    const { apiKey, baseUrl, model } = this.getConfig();
    const submitPath = process.env.LIPSYNC_PROVIDER_SUBMIT_PATH || "/v1/lipsync";

    const body = buildSubmitBody(request, model);

    const res = await this.doFetch(`${baseUrl}${submitPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });

    const data = await this.parseJson(res);
    const providerJobId = data.id ?? data.job_id ?? data.taskId ?? data.task_id;
    if (!providerJobId || typeof providerJobId !== "string") {
      throw new ProviderRequestError(this.name, "Lip-sync provider did not return a job id on submit.");
    }

    return { providerJobId, status: normalizeStatus(data.status) ?? "queued" };
  }

  async getStatus(providerJobId: string): Promise<LipSyncJobResult> {
    const { apiKey, baseUrl } = this.getConfig();
    const statusPathTemplate = process.env.LIPSYNC_PROVIDER_STATUS_PATH || "/v1/lipsync/{id}";
    const statusPath = statusPathTemplate.replace("{id}", encodeURIComponent(providerJobId));

    const res = await this.doFetch(`${baseUrl}${statusPath}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const data = await this.parseJson(res);
    return this.parseStatusResponse(data, apiKey);
  }

  async cancel(providerJobId: string): Promise<void> {
    const { apiKey, baseUrl } = this.getConfig();
    const statusPathTemplate = process.env.LIPSYNC_PROVIDER_STATUS_PATH || "/v1/lipsync/{id}";
    const path = statusPathTemplate.replace("{id}", encodeURIComponent(providerJobId));
    await this.doFetch(`${baseUrl}${path}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
    }).catch(() => undefined); // best-effort - cancellation is not guaranteed by every vendor
  }

  /** Turns a status-endpoint response into a LipSyncJobResult, securely
   * downloading the finished MP4 server-side (never exposing the provider
   * API key or the raw video URL to the frontend) when status is completed. */
  private async parseStatusResponse(
    data: Record<string, unknown>,
    apiKey: string,
  ): Promise<LipSyncJobResult> {
    const status = normalizeStatus(data.status);

    if (status === "failed" || status === "cancelled") {
      const errorMessage =
        (typeof data.error === "string" && data.error) ||
        (typeof (data as { error_message?: unknown }).error_message === "string" &&
          (data as { error_message?: string }).error_message) ||
        "Lip-sync provider reported a failed job.";
      return { status, errorMessage, providerMetadata: { raw: data } };
    }

    if (status !== "completed") {
      return { status: status ?? "processing" };
    }

    const videoUrl =
      (typeof data.video_url === "string" && data.video_url) ||
      (typeof (data as { videoUrl?: unknown }).videoUrl === "string" && (data as { videoUrl?: string }).videoUrl) ||
      (typeof (data as { output?: unknown }).output === "string" && (data as { output?: string }).output) ||
      (Array.isArray((data as { output?: unknown }).output) &&
        (data as { output?: unknown[] }).output?.find((v): v is string => typeof v === "string"));

    if (!videoUrl) {
      throw new ProviderRequestError(this.name, "Lip-sync provider reported completed but returned no video URL.");
    }

    // Secure server-side download (see mediaDownload.ts): the URL is untrusted provider output, so it is
    // SSRF-checked, size/time bounded, and the API key is sent ONLY to the provider's own origin. The URL
    // and any auth never reach the browser - only the resulting bytes, stored by the pipeline stage.
    const baseUrl = process.env.LIPSYNC_PROVIDER_BASE_URL ?? "";
    const dl = await downloadProviderMedia(videoUrl, { provider: this.name, apiKey, baseUrl, what: "lip-synced video" });
    const videoBase64 = dl.buffer.toString("base64");
    const mimeType = dl.contentType || "video/mp4";

    return { status: "completed", videoBase64, mimeType, providerMetadata: { raw: data } };
  }

  private async doFetch(url: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      throw new ProviderRequestError(this.name, `Network error contacting ${this.name}: ${(err as Error).message}`);
    }
    if (res.status === 401 || res.status === 403) throw new ProviderAuthError(this.name);
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw new ProviderRequestError(
        this.name,
        `${this.name} request failed with status ${res.status}${bodyText ? `: ${bodyText.slice(0, 500)}` : ""}.`,
        res.status,
      );
    }
    return res;
  }

  private async parseJson(res: Response): Promise<Record<string, unknown>> {
    try {
      return (await res.json()) as Record<string, unknown>;
    } catch {
      throw new ProviderRequestError(this.name, `${this.name} returned a response that was not valid JSON.`);
    }
  }
}

function buildSubmitBody(request: LipSyncGenerationRequest, model?: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    audio: `data:${request.audioMimeType};base64,${request.audioBase64}`,
  };
  if (model) body.model = model;
  if (request.characterName) body.character_name = request.characterName;
  if (request.imageBase64) body.image = `data:image/png;base64,${request.imageBase64}`;
  if (request.videoBase64) body.video = `data:video/mp4;base64,${request.videoBase64}`;
  return body;
}

function normalizeStatus(raw: unknown): ProviderJobStatus | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.toLowerCase();
  if (["queued", "pending", "created", "waiting"].includes(value)) return "queued";
  if (["processing", "running", "in_progress", "started", "generating"].includes(value)) return "processing";
  if (["completed", "succeeded", "success", "done", "ready"].includes(value)) return "completed";
  if (["failed", "error", "errored"].includes(value)) return "failed";
  if (["cancelled", "canceled"].includes(value)) return "cancelled";
  return undefined;
}
