// THE authoritative per-scene timeline. Every subsystem (voice placement,
// visemes, actors, camera, SFX, music, render) reads this object; none of them
// computes timing on its own. Built AFTER TTS so all durations are measured.
import type {
  ActorEvent, ActorSpan, ActorState, ActorTrack, Emotion, FacialExpression, PlannedSegment, SceneTimeline,
  SegmentAudio, TimedSegment, TransitionPlan, VisemeTrack,
} from "./types";
import { NARRATOR_ID } from "./types";
import { buildVisemeTrack } from "./visemes";
import type { Envelope } from "./audioAnalysis";
import { planCamera } from "./camera";
import { planSfx } from "./sfx";
import { hashParts } from "./cacheKey";

export interface TimelineSegmentInput { planned: PlannedSegment; audio: SegmentAudio; envelope?: Envelope }
export interface TimelineInput {
  sceneId: string;
  sceneNumber: number;
  fps: number;
  language: string;
  segments: TimelineSegmentInput[];
  onScreen: string[]; // character ids on screen, left->right
  positions?: Record<string, { x: number; y: number }>;
  plannedSeconds?: number | null; // used ONLY when the scene has no dialogue
  sceneText: string; // description + mood + location + camera hint
  sfxHints: string[];
  musicMood: string | null;
  isFirstScene: boolean;
  isLastScene?: boolean;
  options?: { leadInSec?: number; tailSec?: number; minSceneSec?: number; blinkMinSec?: number; blinkMaxSec?: number };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const seedOf = (s: string) => parseInt(hashParts(s).slice(0, 8), 16);

const LISTENER_REACTION: Partial<Record<Emotion, FacialExpression>> = {
  angry: "nervous", shouting: "surprised", sad: "sad", crying: "sad", happy: "happy", excited: "happy", laughing: "happy",
  fear: "afraid", surprised: "surprised", romantic: "romantic", confused: "confused", nervous: "nervous",
};

export function buildSceneTimeline(input: TimelineInput): SceneTimeline {
  const o = { leadInSec: 0.35, tailSec: 0.6, minSceneSec: 2.5, blinkMinSec: 2.2, blinkMaxSec: 5.0, ...(input.options ?? {}) };
  const warnings: string[] = [];

  // 1. Place measured segments sequentially. Gap = the larger of the previous
  //    speaker's "after" pause and this speaker's "before" pause.
  const timed: TimedSegment[] = [];
  let cursor = o.leadInSec;
  input.segments.forEach(({ planned, audio }, i) => {
    const prev = timed[i - 1];
    const gap = prev ? Math.max(prev.profile.pauseProfile.afterSec, planned.profile.pauseProfile.beforeSec) : 0;
    const start = r3(cursor + gap);
    const end = r3(start + audio.durationSeconds);
    timed.push({ ...planned, audio, startTime: start, endTime: end, duration: r3(audio.durationSeconds), speakingState: "TALKING", animationState: "TALKING" });
    cursor = end;
  });

  // 2. Duration: audio-derived when there is dialogue (never truncated), planned otherwise.
  const hasDialogue = timed.length > 0;
  const lastEnd = hasDialogue ? timed[timed.length - 1]!.endTime : 0;
  const lastAfter = hasDialogue ? timed[timed.length - 1]!.profile.pauseProfile.afterSec : 0;
  const rawDuration = hasDialogue ? Math.max(o.minSceneSec, lastEnd + Math.max(o.tailSec, lastAfter)) : Math.max(o.minSceneSec, input.plannedSeconds ?? 4);
  // Snap UP to a whole number of frames: video scene offsets then equal audio stem offsets exactly,
  // so audio/video cannot drift apart over a long project.
  const duration = Math.ceil(rawDuration * input.fps - 1e-6) / input.fps;
  if (!hasDialogue && !input.plannedSeconds) warnings.push("Silent scene with no planned duration; defaulted to 4s.");

  // 3. Viseme tracks per segment (from measured speech regions / alignment).
  const visemes: VisemeTrack[] = timed.map((s, i) => buildVisemeTrack({
    segmentId: s.segmentId, characterId: s.characterId, text: s.text, language: input.language,
    segmentStart: s.startTime, duration: s.audio.durationSeconds, speechRegions: s.audio.speechRegions ?? [],
    envelope: input.segments[i]?.envelope, alignment: s.audio.alignment ?? null, fps: input.fps,
  }));
  for (const v of visemes) if (v.quality === "energy-only") warnings.push(`${v.segmentId}: no grapheme rules for "${input.language}"; mouth shapes are amplitude-driven (lower fidelity).`);

  // 4. Actor tracks: talking / listening / reacting / idle + blinks, gaze, nods, gestures.
  const actorIds = [...new Set([...input.onScreen, ...timed.map((s) => s.characterId).filter((id) => id !== NARRATOR_ID && !id.startsWith("unknown:"))])];
  const actors: ActorTrack[] = actorIds.map((id) => buildActorTrack(id, timed, duration, input, o));

  // 5. SFX, camera, music, transition - all from the same timeline numbers.
  const sfx = planSfx(input.sfxHints, { sceneNumber: input.sceneNumber, duration, segments: timed.map((s) => ({ start: s.startTime, end: s.endTime })) });
  const camera = planCamera({
    duration, segments: timed.map((s) => ({ characterId: s.characterId, start: s.startTime, end: s.endTime, emotion: s.emotion, intensity: s.intensity })),
    onScreen: input.onScreen, positions: input.positions, sceneText: input.sceneText,
    sfxTypes: sfx.map((e) => ({ type: e.type, startTime: e.startTime })), isFirstScene: input.isFirstScene,
  });
  const emotional = timed.some((s) => ["sad", "crying", "romantic"].includes(s.emotion));
  const transition: TransitionPlan = input.isLastScene ? { type: "fadeblack", duration: 0.6 } : emotional ? { type: "dip", duration: 0.5 } : { type: "cut", duration: 0 };

  const tl: SceneTimeline = {
    version: 1, sceneId: input.sceneId, sceneNumber: input.sceneNumber, fps: input.fps, duration,
    durationSource: hasDialogue ? "audio" : "planned", segments: timed, visemes, actors, camera, sfx,
    music: { startTime: 0, endTime: duration, baseGain: 0.22, mood: input.musicMood }, transition, warnings,
  };
  return tl;
}

function buildActorTrack(id: string, segs: TimedSegment[], duration: number, input: TimelineInput, o: { blinkMinSec: number; blinkMaxSec: number }): ActorTrack {
  const rnd = mulberry32(seedOf(`${input.sceneId}:${id}`));
  const spans: ActorSpan[] = [];
  const events: ActorEvent[] = [];
  const push = (state: ActorState, start: number, end: number, expression: FacialExpression) => { if (end - start > 1e-3) spans.push({ state, start: r3(start), end: r3(end), expression }); };

  let t = 0;
  segs.forEach((s, i) => {
    const next = segs[i + 1];
    const mine = s.characterId === id;
    if (s.startTime > t) push("IDLE", t, s.startTime, "neutral");
    // Listeners are never expressionless: an intense line shows on their face WHILE they listen.
    const listening: FacialExpression = s.characterId !== NARRATOR_ID && s.intensity >= 0.6 ? (LISTENER_REACTION[s.emotion] ?? "neutral") : "neutral";
    push(mine ? "TALKING" : "LISTENING", s.startTime, s.endTime, mine ? s.profile.facialExpression : listening);
    t = s.endTime;
    const gapEnd = next ? next.startTime : duration;
    if (!mine && s.characterId !== NARRATOR_ID && s.intensity >= 0.6 && gapEnd - t > 0.15) {
      const reactEnd = Math.min(gapEnd, t + 0.7);
      push("REACTION", t, reactEnd, LISTENER_REACTION[s.emotion] ?? "neutral");
      t = reactEnd;
    }
  });
  if (t < duration) push("IDLE", t, duration, "neutral");

  // expression transitions eased over 0.2s at every change
  for (let i = 1; i < spans.length; i++) {
    if (spans[i]!.expression !== spans[i - 1]!.expression) events.push({ kind: "expression", start: spans[i]!.start, end: r3(Math.min(spans[i]!.end, spans[i]!.start + 0.2)), params: { from: spans[i - 1]!.expression, to: spans[i]!.expression } });
  }
  // blinks: seeded, irregular
  let bt = 0.6 + rnd() * 1.4;
  while (bt < duration - 0.2) { events.push({ kind: "blink", start: r3(bt), end: r3(bt + 0.16) }); bt += o.blinkMinSec + rnd() * (o.blinkMaxSec - o.blinkMinSec); }
  // breathing: continuous, subtle
  events.push({ kind: "breathe", start: 0, end: duration, params: { amplitude: 0.004, periodSec: 3.6 + rnd() * 0.8 } });

  for (const s of segs) {
    if (s.characterId === id) {
      // gestures while speaking, per emotion style
      if (s.profile.gestureStyle !== "none") {
        for (let g = s.startTime + 0.3; g < s.endTime - 0.4; g += 2.0) {
          events.push({ kind: "gesture", start: r3(g), end: r3(Math.min(s.endTime, g + 0.8)), params: { style: s.profile.gestureStyle, amplitude: r3(0.3 + 0.7 * s.intensity) } });
        }
      }
    } else if (s.characterId !== NARRATOR_ID) {
      // listener looks at the speaker and nods near the end of longer lines
      events.push({ kind: "gaze", start: s.startTime, end: s.endTime, params: { target: s.characterId } });
      if (s.duration > 1.2 && !["angry", "shouting", "fear", "surprised"].includes(s.emotion)) events.push({ kind: "nod", start: r3(s.endTime - 0.55), end: r3(s.endTime - 0.15), params: { amplitude: r3(0.4 + 0.4 * s.intensity) } });
    }
  }
  events.sort((a, b) => a.start - b.start || a.kind.localeCompare(b.kind));
  return { characterId: id, spans, events };
}

/** Structural invariants; returns human-readable violations (empty = consistent). */
export function validateTimeline(tl: SceneTimeline): string[] {
  const errs: string[] = [];
  const eps = 0.002;
  if (!(tl.duration > 0)) errs.push("duration must be > 0");
  tl.segments.forEach((s, i) => {
    if (s.endTime > tl.duration + eps) errs.push(`${s.segmentId} ends after the scene (${s.endTime} > ${tl.duration})`);
    if (s.startTime < -eps) errs.push(`${s.segmentId} starts before 0`);
    if (Math.abs(s.endTime - s.startTime - s.audio.durationSeconds) > 0.005) errs.push(`${s.segmentId} window != measured audio duration`);
    const prev = tl.segments[i - 1];
    if (prev && s.startTime < prev.endTime - eps) errs.push(`${s.segmentId} overlaps ${prev.segmentId}`);
  });
  for (const s of tl.segments) {
    const v = tl.visemes.find((x) => x.segmentId === s.segmentId);
    if (!v) { errs.push(`${s.segmentId} has no viseme track`); continue; }
    if (Math.abs(v.intervals[0]!.start - s.startTime) > eps || Math.abs(v.intervals[v.intervals.length - 1]!.end - s.endTime) > eps) errs.push(`${s.segmentId} visemes do not cover its audio window`);
    for (let i = 1; i < v.intervals.length; i++) if (Math.abs(v.intervals[i]!.start - v.intervals[i - 1]!.end) > eps) errs.push(`${s.segmentId} viseme gap/overlap at index ${i}`);
  }
  for (const a of tl.actors) {
    for (let i = 1; i < a.spans.length; i++) if (Math.abs(a.spans[i]!.start - a.spans[i - 1]!.end) > eps) errs.push(`actor ${a.characterId} span discontinuity at ${a.spans[i]!.start}`);
    if (a.spans.length && (Math.abs(a.spans[0]!.start) > eps || Math.abs(a.spans[a.spans.length - 1]!.end - tl.duration) > eps)) errs.push(`actor ${a.characterId} spans do not cover the scene`);
    for (const s of tl.segments) if (s.characterId === a.characterId && !a.spans.some((sp) => sp.state === "TALKING" && sp.start <= s.startTime + eps && sp.end >= s.endTime - eps)) errs.push(`actor ${a.characterId} not TALKING during ${s.segmentId}`);
  }
  for (const e of tl.sfx) if (e.startTime < -eps || e.startTime + e.duration > tl.duration + eps) errs.push(`${e.sfxId} outside the scene`);
  for (const m of tl.camera.moves) if (m.start < -eps || m.end > tl.duration + eps) errs.push(`camera move ${m.type} outside the scene`);
  return errs;
}

export function timelineHash(tl: SceneTimeline): string { return hashParts(tl); }
