export interface StoryAnalysisRequest {
  story: string;
  language: string;
  animeStyle: string;
  targetDurationSeconds: number;
}

export interface StructuredCharacter {
  name: string;
  ageRange?: string;
  gender?: string;
  appearance?: string;
  hair?: string;
  eyes?: string;
  clothes?: string;
  accessories?: string;
  personality?: string;
  styleDescription?: string;
}

export interface StructuredScene {
  sceneNumber: number;
  description: string;
  location?: string;
  timeOfDay?: string;
  characters: string[]; // character names referenced in this scene
  cameraAngle?: string;
  cameraMovement?: string;
  lighting?: string;
  mood?: string;
  dialogue?: { character: string; line: string }[];
  narration?: string;
  soundEffects?: string[];
  musicMood?: string;
  imagePrompt: string;
  /**
   * Prompt for the AI video provider (see src/lib/pipeline/videoStage.ts).
   * Expected to explicitly cover: character movement, facial expressions,
   * body movement, hair movement, clothing movement, environmental
   * movement, camera movement, lighting changes, and action choreography -
   * not just a restatement of imagePrompt. See the ACTION/FACIAL/
   * ENVIRONMENT/CAMERA/MOTION structure in SYSTEM_PROMPT
   * (gemini-text-provider.ts).
   */
  animationPrompt?: string;
  /** What the video provider should avoid: identity drift, extra limbs,
   * frozen poses, sudden camera jumps, etc. Passed through as a negative
   * prompt to providers that support one. */
  animationNegativePrompt?: string;
  estimatedDurationSeconds: number;
}

export interface StructuredStory {
  title: string;
  genre: string;
  characters: StructuredCharacter[];
  locations: string[];
  scenes: StructuredScene[];
  mood: string;
  visualStyle: string;
}

/**
 * Abstraction over any LLM capable of turning a raw story into structured
 * scene/character data. The rest of the application depends on this
 * interface only - never on a vendor SDK directly.
 */
export interface TextProvider {
  readonly name: string;
  analyzeStory(request: StoryAnalysisRequest): Promise<StructuredStory>;
  /** Freeform conversational helper (e.g. the /ai-chat brainstorming page). */
  chat(messages: { role: "user" | "assistant"; content: string }[]): Promise<string>;
}
