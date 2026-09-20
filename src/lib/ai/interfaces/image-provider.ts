export interface ImageGenerationRequest {
  prompt: string;
  referenceImageBase64?: string; // for character-consistent regeneration/variation
  size?: "512x512" | "1024x1024" | "1024x1792" | "1792x1024";
}

export interface GeneratedImage {
  imageBase64: string;
  providerName: string;
  providerMetadata?: Record<string, unknown>;
}

/**
 * Abstraction over any image generation backend (character portraits,
 * scene stills). Synchronous by design - the concrete OpenAI adapter
 * returns the finished image directly.
 */
export interface ImageProvider {
  readonly name: string;
  generateImage(request: ImageGenerationRequest): Promise<GeneratedImage>;
  generateVariation(request: ImageGenerationRequest): Promise<GeneratedImage>;
}
