import {
  ImageProvider,
  ImageGenerationRequest,
  GeneratedImage,
} from "@/lib/ai/interfaces/image-provider";
import { openAiFetch } from "@/lib/ai/providers/openai/client";
import { ProviderRequestError } from "@/lib/ai/errors/provider-errors";

export class OpenAiImageProvider implements ImageProvider {
  readonly name = "openai";

  async generateImage(request: ImageGenerationRequest): Promise<GeneratedImage> {
    const model = process.env.OPENAI_IMAGE_MODEL;
    if (!model) throw new ProviderRequestError(this.name, "OPENAI_IMAGE_MODEL is not set.");

    const response = await openAiFetch("/images/generations", {
      model,
      prompt: request.prompt,
      size: request.size ?? "1024x1024",
      n: 1,
    });

    const b64 = response?.data?.[0]?.b64_json;
    if (!b64) throw new ProviderRequestError(this.name, "OpenAI returned no image data.");

    return {
      imageBase64: b64,
      providerName: this.name,
      providerMetadata: { model },
    };
  }

  async generateVariation(request: ImageGenerationRequest): Promise<GeneratedImage> {
    // The current OpenAI image API generates variations by re-prompting with
    // the reference description embedded, since not all models support a
    // dedicated variations endpoint. This keeps behavior consistent across
    // whichever concrete OPENAI_IMAGE_MODEL is configured.
    if (!request.referenceImageBase64) {
      return this.generateImage(request);
    }
    const consistencyPrompt = `${request.prompt}\n\nMaintain exact visual consistency (same character design, outfit, colors) as the previously generated reference for this character.`;
    return this.generateImage({ ...request, prompt: consistencyPrompt });
  }
}
