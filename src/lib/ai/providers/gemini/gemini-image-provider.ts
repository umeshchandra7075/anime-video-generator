import {
  ImageProvider,
  ImageGenerationRequest,
  GeneratedImage,
} from "@/lib/ai/interfaces/image-provider";
import { GoogleGenAI } from "@google/genai";

function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  return new GoogleGenAI({ apiKey });
}

export class GeminiImageProvider implements ImageProvider {
  readonly name = "gemini";

  async generateImage(
    request: ImageGenerationRequest
  ): Promise<GeneratedImage> {
    const ai = getGeminiClient();

    const model =
      process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";

    const response = await ai.models.generateContent({
      model,
      contents: request.prompt,
      config: {
        responseModalities: ["TEXT", "IMAGE"],
      },
    });

    const parts = response.candidates?.[0]?.content?.parts ?? [];

    const imagePart = parts.find(
      (part: any) => part.inlineData?.data
    );

    if (!imagePart?.inlineData?.data) {
      throw new Error("Gemini returned no image data.");
    }

    return {
      imageBase64: imagePart.inlineData.data,
      providerName: this.name,
      providerMetadata: {
        model,
        mimeType: imagePart.inlineData.mimeType || "image/png",
      },
    };
  }

  async generateVariation(
    request: ImageGenerationRequest
  ): Promise<GeneratedImage> {
    const consistencyPrompt = `
${request.prompt}

Maintain strong visual consistency with the existing character reference.
Keep the same character identity, face, hair, eyes, clothing, colors,
body proportions, and anime art style.
`;

    return this.generateImage({
      ...request,
      prompt: consistencyPrompt,
    });
  }
}