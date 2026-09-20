import { GoogleGenAI } from "@google/genai";
import {
  TextProvider,
  StoryAnalysisRequest,
  StructuredStory,
} from "@/lib/ai/interfaces/text-provider";

function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  return new GoogleGenAI({ apiKey });
}

const SYSTEM_PROMPT = `
You are a professional anime screenwriter and storyboard artist.

Convert the user's story into structured pre-production data for an anime video.

Return ONLY valid JSON.

The JSON must contain:
{
  "title": "string",
  "genre": "string",
  "characters": [
    {
      "name": "string",
      "ageRange": "string",
      "gender": "string",
      "appearance": "string",
      "hair": "string",
      "eyes": "string",
      "clothes": "string",
      "accessories": "string",
      "personality": "string",
      "styleDescription": "string"
    }
  ],
  "locations": ["string"],
  "scenes": [
    {
      "sceneNumber": 1,
      "description": "string",
      "location": "string",
      "timeOfDay": "string",
      "characters": ["character name"],
      "cameraAngle": "string",
      "cameraMovement": "string",
      "lighting": "string",
      "mood": "string",
      "dialogue": [
        {
          "character": "string",
          "line": "string"
        }
      ],
      "narration": "string",
      "soundEffects": ["string"],
      "musicMood": "string",
      "imagePrompt": "string",
      "animationPrompt": "string",
      "animationNegativePrompt": "string",
      "estimatedDurationSeconds": 6
    }
  ],
  "mood": "string",
  "visualStyle": "string"
}

Important:
- Create enough scenes to cover the requested duration.
- Each scene should normally be 4 to 8 seconds.
- Keep character appearance (face, hairstyle, eye color, clothing, accessories)
  IDENTICAL across every scene that character appears in - this is critical
  for downstream video generation, which will reject/redo any scene where a
  character's identity drifts from earlier scenes.
- Make imagePrompt highly visual and suitable for anime image generation.

- animationPrompt is for a real AI VIDEO generation model, not a still
  image model. This is the single most important field for making the
  final video look like actual animation instead of a slideshow of static
  images with camera zoom/pan, so give it real substance - never just repeat
  imagePrompt or leave it generic. Write animationPrompt as multiple short,
  concrete, labeled sentences, always covering ALL of the following
  categories that apply to the scene (omit a category only if it is truly
  not applicable, e.g. LIGHTING for a scene with no lighting change):
    ACTION: exactly what each character's body is doing, moment to moment
      (running, turning, reaching, falling, drawing a weapon, etc.) -
      describe arms/legs/torso movement concretely, not just the verb.
    FACIAL: the character's changing facial expression and eye movement
      during the shot (e.g. "eyes widen in fear then narrow with resolve").
    ENVIRONMENT: what moves in the background/foreground - wind through
      leaves, dust in sunbeams, rain, fabric, fire, water, crowd motion.
    CAMERA: a specific camera move (tracking, dolly, pan, tilt, push-in,
      handheld shake, crane) - never a static locked-off shot unless the
      scene specifically calls for stillness.
    LIGHTING: how light/shadow/highlights shift during the shot, if at all.
    MOTION: close with an explicit instruction for continuous, fluid,
      natural anime character animation with consistent anatomy and no
      frozen poses - this line should almost always be present.
  Also fold in hair movement and clothing/fabric movement reacting to the
  action, wind, or camera move wherever the character has hair/loose
  clothing - do not describe a character as static in the middle of action.
  Example of the expected style and level of detail (write your own scene-
  specific version, don't copy this verbatim):
    "ACTION: Ren sprints through the forest, arms pumping and legs driving
    hard against the underbrush. FACIAL: Ren looks frightened, glancing
    back over his shoulder. ENVIRONMENT: Leaves and branches whip in the
    wind, dust motes drift through shafts of sunlight. CAMERA: Dynamic low
    three-quarter tracking shot following Ren, slowly pushing in toward his
    face. LIGHTING: Sunlight flickers through the moving canopy. MOTION:
    Continuous natural anime motion, fluid character animation, consistent
    anatomy, no frozen poses. Ren's hair and jacket react naturally to the
    wind and his own movement."
- Do NOT describe camera zoom/pan/crop over a still frame as the scene's
  motion - describe the characters and environment actually moving, the
  camera move is on top of that, not instead of it.
- animationNegativePrompt: a short comma-separated list (for a video
  model's negative prompt) of what to avoid for THIS scene, always
  including general anti-drift/anti-artifact terms (character face
  changing, hairstyle changing, clothing changing, extra limbs, extra
  fingers, distorted hands, frozen static pose, sudden camera jump/jump
  cut) plus anything scene-specific (e.g. "no crowd in background" for an
  empty street).
- Return valid JSON only.
`;

export class GeminiTextProvider implements TextProvider {
  readonly name = "gemini";

  async analyzeStory(
    request: StoryAnalysisRequest
  ): Promise<StructuredStory> {
    const ai = getGeminiClient();

    const model = process.env.GEMINI_TEXT_MODEL || "gemini-3.8-flash";

    const prompt = `
${SYSTEM_PROMPT}

Story:
${request.story}

Language:
${request.language}

Anime Style:
${request.animeStyle}

Target Duration:
${request.targetDurationSeconds} seconds
`;

    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
      },
    });

    const text = response.text;

    if (!text) {
      throw new Error("Gemini returned an empty response.");
    }

    try {
      const parsed = JSON.parse(text) as StructuredStory;

      if (!parsed.scenes || !Array.isArray(parsed.scenes)) {
        throw new Error("Gemini response does not contain scenes.");
      }

      return parsed;
    } catch {
      console.error("Gemini returned invalid JSON:", text);
      throw new Error("Gemini returned invalid story JSON.");
    }
  }

  async chat(
    messages: { role: "user" | "assistant"; content: string }[]
  ): Promise<string> {
    const ai = getGeminiClient();

    const model = process.env.GEMINI_TEXT_MODEL || "gemini-3.5-flash";

    const contents = messages.map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    }));

    const response = await ai.models.generateContent({
      model,
      contents,
      config: {
        systemInstruction:
          "You are a creative writing assistant for an anime video generator. Help users brainstorm anime stories, characters and scenes. Keep responses concise and useful.",
      },
    });

    return response.text || "";
  }
}