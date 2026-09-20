// Shared vocabulary for the animation/audio engine. Everything downstream
// (voice, lip-sync, puppet, camera, mixer, render) reads the SAME
// SceneTimeline built in timeline.ts - no subsystem computes timing itself.

export const EMOTIONS = [
  "happy", "sad", "angry", "excited", "fear", "surprised", "calm", "serious",
  "romantic", "confused", "whispering", "shouting", "crying", "laughing",
  "determined", "nervous",
] as const;
export type Emotion = (typeof EMOTIONS)[number];

export const VISEMES = [
  "REST", "MBP", "FV", "TH", "TD", "KG", "CHJ", "SZ",
  "AE", "AA", "EH", "EE", "IH", "OH", "OO", "WQ",
] as const;
export type Viseme = (typeof VISEMES)[number];

export type FacialExpression =
  | "neutral" | "happy" | "sad" | "angry" | "surprised" | "afraid"
  | "confused" | "romantic" | "determined" | "nervous";
export type GestureStyle = "none" | "subtle" | "calm" | "expressive" | "aggressive" | "trembling";

/** Animation states from the product spec. Only the subset marked (impl) is
 * actually driven by this engine; the rest are declared so scene plans can
 * name them, and are reported as unsupported by `supportedActorStates`. */
export const ACTOR_STATES = [
  "IDLE", "TALKING", "LISTENING", "REACTION", "THINKING",
  "WALKING", "RUNNING", "TURNING", "POINTING", "WAVING", "ANGRY", "SAD", "HAPPY",
  "SURPRISED", "SCARED", "ATTACKING", "DEFENDING",
] as const;
export type ActorState = (typeof ACTOR_STATES)[number];
export const IMPLEMENTED_ACTOR_STATES: readonly ActorState[] = ["IDLE", "TALKING", "LISTENING", "REACTION"];

export const NARRATOR_ID = "narrator";

export interface PauseProfile { beforeSec: number; afterSec: number }

export interface EmotionProfile {
  emotion: Emotion;
  intensity: number; // 0..1
  speechRate: number; // multiplier, 1 = neutral
  pitchModifier: number; // semitones, 0 = neutral (only applied if provider supports pitch)
  pauseProfile: PauseProfile;
  facialExpression: FacialExpression;
  gestureStyle: GestureStyle;
}

export interface VoiceRef {
  provider: string; // "elevenlabs" | "openai" | ...
  voiceId: string;
  modelId?: string;
}

/** A dialogue line before its audio exists. */
export interface PlannedSegment {
  segmentId: string; // deterministic: dlg_<scene>_<index>
  characterId: string; // character id, NARRATOR_ID, or "unknown:<slug>"
  speakerName: string;
  text: string;
  emotion: Emotion;
  intensity: number;
  voice: VoiceRef | null; // null => provider default (flagged via voiceFallback)
  voiceFallback: boolean; // true when the speaker had no assigned voice
  profile: EmotionProfile;
}

export interface CharAlignment {
  characters: string[];
  startTimes: number[]; // seconds, per character
  endTimes: number[];
}

export interface SegmentAudio {
  storageKey: string;
  mimeType: string;
  durationSeconds: number; // MEASURED from decoded samples, never estimated
  cacheKey: string;
  alignment?: CharAlignment; // only when the provider returned real timestamps
  speechRegions?: Array<{ start: number; end: number }>; // measured VAD, relative to segment audio
}

export interface TimedSegment extends PlannedSegment {
  audio: SegmentAudio;
  startTime: number; // absolute within the scene
  endTime: number;
  duration: number;
  speakingState: "TALKING";
  animationState: ActorState;
}

export interface VisemeInterval { start: number; end: number; viseme: Viseme }
export type VisemeQuality = "provider-alignment" | "audio-aligned" | "energy-only";
export interface VisemeTrack {
  segmentId: string;
  characterId: string;
  quality: VisemeQuality;
  intervals: VisemeInterval[]; // scene-absolute, contiguous coverage of the segment
}

export type ActorEventKind = "blink" | "nod" | "gaze" | "gesture" | "expression" | "breathe";
export interface ActorEvent {
  kind: ActorEventKind;
  start: number;
  end: number;
  params?: Record<string, number | string>;
}
export interface ActorSpan { state: ActorState; start: number; end: number; expression: FacialExpression }
export interface ActorTrack { characterId: string; spans: ActorSpan[]; events: ActorEvent[] }

export type ShotType =
  | "WIDE" | "MEDIUM" | "CLOSEUP" | "EXTREME_CLOSEUP" | "TWO_SHOT"
  | "OVER_SHOULDER" | "LOW_ANGLE" | "HIGH_ANGLE" | "DYNAMIC" | "TRACKING";
export type CameraMoveType =
  | "zoomIn" | "zoomOut" | "panLeft" | "panRight" | "panUp" | "panDown"
  | "track" | "shake" | "focusTransition";
export interface CameraMove {
  type: CameraMoveType;
  start: number;
  end: number;
  /** zoom moves: target zoom factor; pan/track/focus: normalized frame fraction; shake: amplitude fraction */
  amount: number;
  /** focusTransition/track: normalized target x,y (0..1) */
  toX?: number;
  toY?: number;
}
export interface CameraPlan {
  shot: ShotType;
  baseZoom: number;
  focusX: number; // normalized 0..1
  focusY: number;
  moves: CameraMove[];
  reason: string; // why this shot/move was chosen (deterministic rule name)
}

export type SfxType =
  | "footstep" | "door" | "rain" | "wind" | "thunder" | "sword"
  | "impact" | "explosion" | "magic" | "crowd" | "vehicle";
export interface SfxEvent {
  sfxId: string;
  type: SfxType;
  startTime: number;
  duration: number;
  volume: number; // linear gain 0..1
  source: "procedural" | "provider";
  ref: string; // characterId or event label this SFX belongs to
  priority: number; // higher wins when the mix is crowded
  loop: boolean;
}

export interface MusicCue {
  startTime: number;
  endTime: number;
  baseGain: number; // linear
  mood: string | null;
}

/** "dip" = fade out then in around the cut. It preserves timing; a true overlapping
 * crossfade would shorten the video relative to the audio stems and is deliberately not offered. */
export interface TransitionPlan { type: "cut" | "dip" | "fadeblack"; duration: number }

export interface SceneTimeline {
  version: 1;
  sceneId: string;
  sceneNumber: number;
  fps: number;
  duration: number;
  durationSource: "audio" | "planned";
  segments: TimedSegment[];
  visemes: VisemeTrack[];
  actors: ActorTrack[];
  camera: CameraPlan;
  sfx: SfxEvent[];
  music: MusicCue;
  transition: TransitionPlan;
  warnings: string[];
}
