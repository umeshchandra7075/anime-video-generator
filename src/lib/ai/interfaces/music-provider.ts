import { ProviderJobStatus } from "@/lib/ai/interfaces/video-provider";

export interface MusicGenerationRequest {
  mood: string;
  durationSeconds: number;
  kind: "music" | "sfx";
  description?: string; // e.g. "footsteps on wet pavement" for SFX
}

export interface MusicJobHandle {
  providerJobId: string;
  status: ProviderJobStatus;
}

export interface MusicJobResult {
  status: ProviderJobStatus;
  audioBase64?: string;
  mimeType?: string;
  errorMessage?: string;
  providerMetadata?: Record<string, unknown>;
}

export interface MusicProvider {
  readonly name: string;
  submit(request: MusicGenerationRequest): Promise<MusicJobHandle>;
  getStatus(providerJobId: string): Promise<MusicJobResult>;
}
