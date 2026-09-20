import { ProviderJobStatus } from "@/lib/ai/interfaces/video-provider";

/**
 * Lip-sync providers take a speaking character's face (a still portrait or
 * an already-animated clip) plus the exact dialogue/narration audio that
 * will play over it, and return a new clip where the character's mouth is
 * driven by that audio - real audio-to-viseme lip sync, not a canned
 * open/closed loop. This matches how every real lip-sync/talking-avatar API
 * works (sync.so, D-ID, HeyGen, Wav2Lip-as-a-service, etc.): submit a job,
 * poll, download the finished clip. See HttpLipSyncProvider for the generic
 * adapter and how to point it at a specific vendor.
 */

export interface LipSyncGenerationRequest {
  /** Base64-encoded PNG/JPEG of the character's face/portrait - used when
   * the provider generates a talking-head clip from a single reference
   * image (the common case for this pipeline, since scene characters are
   * static reference images - see Character.referenceImageUrl). */
  imageBase64?: string;
  /** Base64-encoded MP4 of an already-animated clip whose mouth should be
   * redriven by the audio - used instead of imageBase64 for providers that
   * lip-sync an existing video rather than animate from a still. Exactly
   * one of imageBase64 / videoBase64 is required. */
  videoBase64?: string;
  /** Base64-encoded dialogue/narration audio (MP3/WAV) this clip must be
   * synchronized to. Required. */
  audioBase64: string;
  audioMimeType: string;
  /** Compact character context (name, appearance) some providers use to
   * keep identity/expression consistent. Optional - providers with no use
   * for it simply ignore it. */
  characterName?: string;
}

export interface LipSyncJobHandle {
  providerJobId: string;
  status: ProviderJobStatus;
}

export interface LipSyncJobResult {
  status: ProviderJobStatus;
  videoBase64?: string; // present only when status === "completed"
  mimeType?: string;
  errorMessage?: string; // present only when status === "failed"
  providerMetadata?: Record<string, unknown>;
}

export interface LipSyncProvider {
  readonly name: string;
  submit(request: LipSyncGenerationRequest): Promise<LipSyncJobHandle>;
  getStatus(providerJobId: string): Promise<LipSyncJobResult>;
  cancel?(providerJobId: string): Promise<void>;
}
