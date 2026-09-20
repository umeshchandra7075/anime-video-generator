import { TextProvider, StoryAnalysisRequest, StructuredStory } from "@/lib/ai/interfaces/text-provider";
import { openAiFetch } from "@/lib/ai/providers/openai/client";
import { ProviderRequestError } from "@/lib/ai/errors/provider-errors";

const SYSTEM_PROMPT = `You are a professional anime screenwriter and storyboard artist.
Convert the user's story into structured pre-production data for an anime video.
Respond with ONLY valid JSON matching exactly this shape, no prose, no markdown fences:

{
  "title": string,
  "genre": string,
  "characters": [{
    "name": string, "ageRange": string, "gender": string, "appearance": string,
    "hair": string, "eyes": string, "clothes": string, "accessories": string,
    "personality": string, "styleDescription": string
  }],
  "locations": [string],
  "scenes": [{
    "sceneNumber": number, "description": string, "location": string, "timeOfDay": string,
    "characters": [string], "cameraAngle": string, "cameraMovement": string, "lighting": string,
    "mood": string, "dialogue": [{"character": string, "line": string}], "narration": string,
    "soundEffects": [string], "musicMood": string, "imagePrompt": string, "animationPrompt": string,
    "estimatedDurationSeconds": number
  }],
  "mood": string,
  "visualStyle": string
}

Keep character descriptions detailed and IDENTICAL wording across all scenes involving
that character so downstream image generation stays visually consistent. Break the story
into scenes whose estimatedDurationSeconds sum to approximately the requested total duration.`;

export class OpenAiTextProvider implements TextProvider {
  readonly name = "openai";

  async analyzeStory(request: StoryAnalysisRequest): Promise<StructuredStory> {
    const model = process.env.OPENAI_TEXT_MODEL;
    if (!model) throw new ProviderRequestError(this.name, "OPENAI_TEXT_MODEL is not set.");

    const userPrompt = `Story:\n${request.story}\n\nLanguage: ${request.language}\nAnime style: ${request.animeStyle}\nTarget total duration (seconds): ${request.targetDurationSeconds}`;

    const response = await openAiFetch("/chat/completions", {
      model,
      response_format: { type: "json_object" },
      temperature: 0.7,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    });

    const raw = response?.choices?.[0]?.message?.content;
    if (!raw) throw new ProviderRequestError(this.name, "OpenAI returned no content.");

    let parsed: StructuredStory;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ProviderRequestError(this.name, "OpenAI returned malformed JSON.");
    }

    if (!parsed.scenes || !Array.isArray(parsed.scenes) || parsed.scenes.length === 0) {
      throw new ProviderRequestError(this.name, "OpenAI response did not contain any scenes.");
    }

    return parsed;
  }

  async chat(messages: { role: "user" | "assistant"; content: string }[]): Promise<string> {
    const model = process.env.OPENAI_TEXT_MODEL;
    if (!model) throw new ProviderRequestError(this.name, "OPENAI_TEXT_MODEL is not set.");

    const response = await openAiFetch("/chat/completions", {
      model,
      temperature: 0.8,
      messages: [
        {
          role: "system",
          content:
            "You are a creative writing assistant for an anime video generator. Help the user brainstorm story ideas, characters, and scenes. Keep replies concise and inspiring.",
        },
        ...messages,
      ],
    });

    const reply = response?.choices?.[0]?.message?.content;
    if (!reply) throw new ProviderRequestError(this.name, "OpenAI returned no reply.");
    return reply;
  }
}
