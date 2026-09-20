/**
 * Video generation providers are treated as asynchronous by default, since
 * essentially every real video-generation API works this way: you submit a
 * job, poll (or receive a webhook), and later fetch the finished asset.
 *
 * A synchronous provider can still implement this interface trivially by
 * having submit() do the work and immediately return a job that is already
 * "completed" with the result attached - the rest of the application never
 * needs to know the difference.
 */

export type ProviderJobStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";

export interface VideoGenerationRequest {
  prompt: string;
  referenceImageBase64?: string; // anchors the clip to a specific scene image
  durationSeconds: number;
  aspectRatio: "16:9" | "9:16" | "1:1";
  /**
   * Things the provider should avoid generating, when it supports negative
   * prompting (identity drift, extra limbs, frozen poses, jump cuts, etc.
   * - see DEFAULT_NEGATIVE_PROMPT in src/lib/pipeline/videoStage.ts).
   * Providers that don't support this field simply ignore it.
   */
  negativePrompt?: string;
  /**
   * Compact structured character/action context (names, appearance, what
   * they're doing in this scene) folded into the prompt sent to the
   * provider, to reinforce cross-scene character consistency. Optional -
   * providers with no use for it simply ignore it.
   */
  characterInfo?: string;
}

export interface VideoJobHandle {
  providerJobId: string;
  status: ProviderJobStatus;
}

export interface VideoJobResult {
  status: ProviderJobStatus;
  videoBase64?: string; // present only when status === "completed"
  mimeType?: string;
  errorMessage?: string; // present only when status === "failed"
  providerMetadata?: Record<string, unknown>;
}

export interface VideoProvider {
  readonly name: string;
  submit(request: VideoGenerationRequest): Promise<VideoJobHandle>;
  getStatus(providerJobId: string): Promise<VideoJobResult>;
  cancel?(providerJobId: string): Promise<void>;
}



