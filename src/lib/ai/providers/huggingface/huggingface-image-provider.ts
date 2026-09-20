// import {
//   ImageProvider,
//   ImageGenerationRequest,
//   GeneratedImage,
// } from "@/lib/ai/interfaces/image-provider";
// import { InferenceClient } from "@huggingface/inference";

// function getHuggingFaceClient() {
//   const token = process.env.HF_TOKEN;

//   if (!token) {
//     throw new Error("HF_TOKEN is not configured.");
//   }

//   return new InferenceClient(token);
// }

// export class HuggingFaceImageProvider implements ImageProvider {
//   readonly name = "huggingface";

//   async generateImage(
//     request: ImageGenerationRequest
//   ): Promise<GeneratedImage> {
//     const hf = getHuggingFaceClient();

//     const model =
//       process.env.HF_IMAGE_MODEL ||
//       "stabilityai/stable-diffusion-3-medium-diffusers";

//     const image = await hf.textToImage({
//       model,
//       inputs: request.prompt,
//       provider: "hf-inference",
//     });

//     const arrayBuffer = await image.arrayBuffer();
//     const imageBase64 = Buffer.from(arrayBuffer).toString("base64");

//     return {
//       imageBase64,
//       providerName: this.name,
//       providerMetadata: {
//         model,
//         mimeType: image.type || "image/png",
//       },
//     };
//   }

//   async generateVariation(
//     request: ImageGenerationRequest
//   ): Promise<GeneratedImage> {
//     return this.generateImage({
//       ...request,
//       prompt: `${request.prompt}

// Maintain strong visual consistency.
// Keep the same anime character identity, face, hair, eyes,
// clothing, colors, body proportions, and art style.`,
//     });
//   }
// }


import {
  ImageProvider,
  ImageGenerationRequest,
  GeneratedImage,
} from "@/lib/ai/interfaces/image-provider";
import { InferenceClient } from "@huggingface/inference";

function getHuggingFaceClient() {
  const token = process.env.HF_TOKEN;

  if (!token) {
    throw new Error("HF_TOKEN is not configured.");
  }

  return new InferenceClient(token);
}

export class HuggingFaceImageProvider implements ImageProvider {
  readonly name = "huggingface";

  async generateImage(
    request: ImageGenerationRequest
  ): Promise<GeneratedImage> {
    const hf = getHuggingFaceClient();

    const model =
      process.env.HF_IMAGE_MODEL ||
      "stabilityai/stable-diffusion-3-medium-diffusers";

    const image = await hf.textToImage(
      {
        model,
        inputs: request.prompt,
        provider: "hf-inference",
      },
      {
        outputType: "blob",
      }
    );

    const arrayBuffer = await image.arrayBuffer();
    const imageBase64 = Buffer.from(arrayBuffer).toString("base64");

    return {
      imageBase64,
      providerName: this.name,
      providerMetadata: {
        model,
        mimeType: image.type || "image/png",
      },
    };
  }

  async generateVariation(
    request: ImageGenerationRequest
  ): Promise<GeneratedImage> {
    return this.generateImage({
      ...request,
      prompt: `${request.prompt}

Maintain strong visual consistency.
Keep the same anime character identity, face, hair, eyes,
clothing, colors, body proportions, and art style.`,
    });
  }
}