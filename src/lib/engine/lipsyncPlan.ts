import type { SceneTimeline, VisemeQuality } from "./types";
import { NARRATOR_ID } from "./types";

export type LipSyncMode = "rig" | "provider-video" | "visemes-only" | "none";
export interface LipSyncPlan {
  sceneNumber: number;
  mode: LipSyncMode;
  reason: string;
  speakers: string[];
  visemeQuality: VisemeQuality[];
  /** Honest user-facing status; never claims lip-sync that is not applied to the video. */
  appliedToVideo: boolean;
}

/** Decides HOW a scene's lip-sync is realised. The viseme timeline itself always exists (it comes from the
 * measured audio); this says whether anything actually moves a mouth in the rendered video. A talking-head
 * from a static portrait replacing the scene is never an option. */
export function planSceneLipSync(tl: SceneTimeline, ctx: { providerConfigured: boolean; hasVideoClip: boolean; rigCharacterIds: string[] }): LipSyncPlan {
  const speakers = [...new Set(tl.segments.map((s) => s.characterId).filter((id) => id !== NARRATOR_ID && !id.startsWith("unknown:")))];
  const visemeQuality = [...new Set(tl.visemes.filter((v) => speakers.includes(v.characterId)).map((v) => v.quality))];
  const base = { sceneNumber: tl.sceneNumber, speakers, visemeQuality };
  if (speakers.length === 0) return { ...base, mode: "none", reason: "No on-screen character speaks in this scene.", appliedToVideo: false };
  if (speakers.every((id) => ctx.rigCharacterIds.includes(id))) return { ...base, mode: "rig", reason: "All speakers have layered rigs: mouths are composited from the viseme timeline.", appliedToVideo: true };
  if (ctx.providerConfigured && ctx.hasVideoClip && speakers.length === 1) {
    return { ...base, mode: "provider-video", reason: "Single speaker: the animated scene clip is re-lip-synced by the provider (video-to-video), preserving body, camera and background.", appliedToVideo: true };
  }
  if (speakers.length > 1 && ctx.providerConfigured) {
    return { ...base, mode: "visemes-only", reason: "Multi-speaker scene without rigs: a single-face provider pass could not tell whose mouth to drive, so it was skipped. The viseme timeline is available; add layered rigs for these characters to animate them.", appliedToVideo: false };
  }
  return { ...base, mode: "visemes-only", reason: ctx.providerConfigured ? "No animated clip is available for provider lip-sync." : "Lip-sync provider is not configured; the viseme timeline was generated but no mouth animation is applied to the video.", appliedToVideo: false };
}
