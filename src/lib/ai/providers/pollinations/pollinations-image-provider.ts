import {
  ImageProvider,
  ImageGenerationRequest,
  GeneratedImage,
} from "@/lib/ai/interfaces/image-provider";

function getApiKey(): string {
  const apiKey = process.env.POLLINATIONS_API_KEY;

  if (!apiKey) {
    throw new Error("POLLINATIONS_API_KEY is not configured.");
  }

  return apiKey;
}

function getDimensions(size?: string) {
  switch (size) {
    case "512x512":
      return { width: 512, height: 512 };

    case "768x768":
      return { width: 768, height: 768 };

    case "1024x1024":
    default:
      return { width: 1024, height: 1024 };
  }
}

export class PollinationsImageProvider implements ImageProvider {
  readonly name = "pollinations";

  async generateImage(
    request: ImageGenerationRequest
  ): Promise<GeneratedImage> {
    const apiKey = getApiKey();

    const model =
      process.env.POLLINATIONS_IMAGE_MODEL || "flux";

    const { width, height } = getDimensions(request.size);

    const prompt = request.prompt.trim();

    if (!prompt) {
      throw new Error("Image prompt cannot be empty.");
    }

    const url =
      `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}` +
      `?model=${encodeURIComponent(model)}` +
      `&width=${width}` +
      `&height=${height}` +
      `&nologo=true`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();

      throw new Error(
        `Pollinations image generation failed (${response.status}): ${errorText}`
      );
    }

    const arrayBuffer = await response.arrayBuffer();

    if (arrayBuffer.byteLength === 0) {
      throw new Error("Pollinations returned an empty image.");
    }

    const imageBase64 =
      Buffer.from(arrayBuffer).toString("base64");

    const mimeType =
      response.headers.get("content-type") || "image/png";

    return {
      imageBase64,
      providerName: this.name,
      providerMetadata: {
        model,
        width,
        height,
        mimeType,
      },
    };
  }

  async generateVariation(
    request: ImageGenerationRequest
  ): Promise<GeneratedImage> {
    return this.generateImage({
      ...request,
      prompt: `${request.prompt}

Maintain strong visual consistency with the existing anime character.
Keep the same character identity, face, hair, eyes, clothing,
colors, accessories, body proportions, and anime art style.`,
    });
  }
}
