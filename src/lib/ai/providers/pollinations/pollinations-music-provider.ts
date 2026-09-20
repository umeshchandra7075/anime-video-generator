import {
  MusicProvider,
  MusicGenerationRequest,
  MusicJobHandle,
  MusicJobResult,
} from "@/lib/ai/interfaces/music-provider";
import { ProviderNotConfiguredError, ProviderRequestError, ProviderTimeoutError } from "@/lib/ai/errors/provider-errors";

import { randomUUID } from "crypto";

const jobs = new Map<string, MusicJobResult>();

// Pollinations can be slow/unresponsive under load; bound the request so a
// hung connection surfaces as a typed, recoverable ProviderTimeoutError
// instead of hanging the whole generation job indefinitely.
const REQUEST_TIMEOUT_MS = 45_000;

function getApiKey(): string {
  const apiKey = process.env.POLLINATIONS_API_KEY;

  if (!apiKey) {
    // Typed so callers (musicStage) can distinguish "not configured" from a
    // generic failure and fall back gracefully instead of failing the job.
    throw new ProviderNotConfiguredError("pollinations-music");
  }

  return apiKey;
}

export class PollinationsMusicProvider implements MusicProvider {
  readonly name = "pollinations";

  async submit(
    request: MusicGenerationRequest
  ): Promise<MusicJobHandle> {
    const apiKey = getApiKey();

    const jobId = randomUUID();

    jobs.set(jobId, {
      status: "processing",
    });

    try {
      const prompt =
        request.kind === "sfx"
          ? `Sound effect: ${request.description || request.mood}`
          : `Background music: ${request.mood}. ${request.description || ""}`;

      const model =
        request.kind === "sfx"
          ? process.env.POLLINATIONS_SFX_MODEL ||
            "elevenlabs/eleven-text-to-sound-v2"
          : process.env.POLLINATIONS_MUSIC_MODEL ||
            "elevenlabs/music-v2";

      const url =
        `https://gen.pollinations.ai/audio/${encodeURIComponent(prompt)}` +
        `?model=${encodeURIComponent(model)}` +
        `&duration=${Math.max(3, Math.round(request.durationSeconds))}` +
        `&response_format=mp3`;

      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
          signal: controller.signal,
        });
      } catch (fetchError) {
        // AbortError (timeout) and generic network errors (DNS failure,
        // connection reset, etc.) both count as recoverable - the caller
        // can fall back to local generation rather than failing the job.
        if (fetchError instanceof Error && fetchError.name === "AbortError") {
          throw new ProviderTimeoutError("pollinations-music");
        }
        throw new ProviderRequestError(
          "pollinations-music",
          fetchError instanceof Error ? fetchError.message : "Network error contacting Pollinations.",
        );
      } finally {
        clearTimeout(timeoutHandle);
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");

        throw new ProviderRequestError(
          "pollinations-music",
          `Pollinations audio generation failed (${response.status}): ${errorText}`,
          response.status,
        );
      }

      const audioBuffer = await response.arrayBuffer();

      if (audioBuffer.byteLength === 0) {
        throw new ProviderRequestError("pollinations-music", "Pollinations returned empty audio.");
      }

      jobs.set(jobId, {
        status: "completed",
        audioBase64: Buffer.from(audioBuffer).toString("base64"),
        mimeType:
          response.headers.get("content-type") || "audio/mpeg",
        providerMetadata: {
          provider: "pollinations",
          model,
          kind: request.kind,
          durationSeconds: request.durationSeconds,
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
          : "Pollinations audio generation failed.";

      jobs.set(jobId, {
        status: "failed",
        errorMessage: message,
      });

      throw error;
    }
  }

  async getStatus(
    providerJobId: string
  ): Promise<MusicJobResult> {
    const result = jobs.get(providerJobId);

    if (!result) {
      return {
        status: "failed",
        errorMessage: "Audio job was not found.",
      };
    }

    return result;
  }
}