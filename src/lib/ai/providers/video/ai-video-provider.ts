import {
  VideoProvider,
  VideoGenerationRequest,
  VideoJobHandle,
  VideoJobResult,
  ProviderJobStatus,
} from "@/lib/ai/interfaces/video-provider";
import { downloadProviderMedia } from "@/lib/ai/providers/mediaDownload";
import { ProviderAuthError, ProviderNotConfiguredError, ProviderRequestError } from "@/lib/ai/errors/provider-errors";

/**
 * Configurable adapter for a real (non-FFmpeg) AI image-to-video API -
 * Runway, Kling, Pika, Luma, and similar services all follow the same
 * shape: submit a job with a prompt + reference image, poll a status
 * endpoint until it's done, then download the finished MP4 from a URL.
 *
 * There is no single universal video-generation API, so this adapter
 * defines one reasonable, documented request/response contract (see
 * `buildSubmitBody` / `parseStatusResponse` below) and makes every part of
 * it configurable through environment variables so it can be pointed at
 * whichever vendor you've actually signed up with:
 *
 *   VIDEO_PROVIDER               - a short tag identifying the vendor, used
 *                                   for logging and SceneAsset.providerName
 *                                   (e.g. "runway", "kling", "pika").
 *   VIDEO_PROVIDER_API_KEY        - bearer token / API key (required).
 *   VIDEO_PROVIDER_BASE_URL       - e.g. https://api.vendor.com (required).
 *   VIDEO_PROVIDER_MODEL          - optional model id sent in the request body.
 *   VIDEO_PROVIDER_SUBMIT_PATH    - default "/v1/videos".
 *   VIDEO_PROVIDER_STATUS_PATH    - default "/v1/videos/{id}" ("{id}" is
 *                                   substituted with the job id returned by
 *                                   the submit call).
 *
 * If your chosen vendor's JSON field names differ from the ones this
 * adapter sends/expects (very likely - every vendor's API is slightly
 * different), adjust `buildSubmitBody` and `parseStatusResponse` below to
 * match their actual contract. Everything else in this class (auth header,
 * polling integration, error mapping, secure server-side download) stays
 * the same regardless of vendor.
 */
export class HttpVideoProvider implements VideoProvider {
  readonly name: string;

  constructor() {
    this.name = (process.env.VIDEO_PROVIDER || "").trim() || "ai-video";
  }

  private getConfig(): { apiKey: string; baseUrl: string; model?: string } {
    const apiKey = process.env.VIDEO_PROVIDER_API_KEY;
    const baseUrl = process.env.VIDEO_PROVIDER_BASE_URL;
    if (!apiKey || !baseUrl) {
      throw new ProviderNotConfiguredError(this.name);
    }
    return { apiKey, baseUrl: baseUrl.replace(/\/+$/, ""), model: process.env.VIDEO_PROVIDER_MODEL };
  }

  async submit(request: VideoGenerationRequest): Promise<VideoJobHandle> {
    const { apiKey, baseUrl, model } = this.getConfig();
    const submitPath = process.env.VIDEO_PROVIDER_SUBMIT_PATH || "/v1/videos";

    const body = buildSubmitBody(request, model);

    const res = await this.doFetch(`${baseUrl}${submitPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });

    const data = await this.parseJson(res);
    const providerJobId = data.id ?? data.job_id ?? data.taskId ?? data.task_id;
    if (!providerJobId || typeof providerJobId !== "string") {
      throw new ProviderRequestError(this.name, "Video provider did not return a job id on submit.");
    }

    return { providerJobId, status: normalizeStatus(data.status) ?? "queued" };
  }

  async getStatus(providerJobId: string): Promise<VideoJobResult> {
    const { apiKey, baseUrl } = this.getConfig();
    const statusPathTemplate = process.env.VIDEO_PROVIDER_STATUS_PATH || "/v1/videos/{id}";
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
    const statusPathTemplate = process.env.VIDEO_PROVIDER_STATUS_PATH || "/v1/videos/{id}";
    const path = statusPathTemplate.replace("{id}", encodeURIComponent(providerJobId));
    await this.doFetch(`${baseUrl}${path}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
    }).catch(() => undefined); // best-effort - cancellation is not guaranteed by every vendor
  }

  /** Turns a status-endpoint response into a VideoJobResult, securely
   * downloading the finished MP4 server-side (never exposing the provider
   * API key or the raw video URL to the frontend) when status is completed. */
  private async parseStatusResponse(
    data: Record<string, unknown>,
    apiKey: string,
  ): Promise<VideoJobResult> {
    const status = normalizeStatus(data.status);

    if (status === "failed" || status === "cancelled") {
      const errorMessage =
        (typeof data.error === "string" && data.error) ||
        (typeof (data as { error_message?: unknown }).error_message === "string" &&
          (data as { error_message?: string }).error_message) ||
        "Video provider reported a failed job.";
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
      throw new ProviderRequestError(this.name, "Video provider reported completed but returned no video URL.");
    }

    // Secure server-side download (see mediaDownload.ts): the URL is untrusted provider output, so it is
    // SSRF-checked, size/time bounded, and the API key is sent ONLY to the provider's own origin. The URL
    // and any auth never reach the browser - only the resulting bytes, stored by the pipeline stage.
    const baseUrl = process.env.VIDEO_PROVIDER_BASE_URL ?? "";
    const dl = await downloadProviderMedia(videoUrl, { provider: this.name, apiKey, baseUrl, what: "generated video" });
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

function buildSubmitBody(request: VideoGenerationRequest, model?: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    prompt: request.prompt,
    duration_seconds: request.durationSeconds,
    aspect_ratio: request.aspectRatio,
  };
  if (model) body.model = model;
  if (request.negativePrompt) body.negative_prompt = request.negativePrompt;
  if (request.characterInfo) body.character_context = request.characterInfo;
  if (request.referenceImageBase64) body.image = `data:image/png;base64,${request.referenceImageBase64}`;
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
