import type { TTSProvider } from "@/lib/ai/interfaces/tts-provider";
import { toJson, fromJson } from "@/lib/domain/json";
import { parseCharacterVoiceConfig, resolveCharacterVoice } from "@/lib/domain/characterVoice";
import type { CharacterVoiceConfig } from "@/lib/domain/characterVoice";
import { planDialogueSegments, castVoices } from "@/lib/engine/dialogue";
import type { CharacterInfo, VoicePoolEntry, SegmentIssue } from "@/lib/engine/dialogue";
import { synthesizeSegments } from "@/lib/engine/voicePipeline";
import type { BlobStore, SegmentOutcome, VoiceSynth } from "@/lib/engine/voicePipeline";
import { buildSceneTimeline, validateTimeline } from "@/lib/engine/timeline";
import { normalizeEmotion } from "@/lib/engine/emotion";
import type { PlannedSegment, SceneTimeline, VoiceRef } from "@/lib/engine/types";

export interface VoiceSceneInput {
  id: string;
  sceneNumber: number;
  narration: string | null;
  dialogue: string | null; // JSON-encoded {character,line,emotion?}[]
  // Optional context used for the master timeline (camera, SFX, music, on-screen cast):
  description?: string | null;
  location?: string | null;
  mood?: string | null;
  cameraAngle?: string | null;
  cameraMovement?: string | null;
  soundEffects?: string | null; // JSON string[]
  musicMood?: string | null;
  characterIds?: string | null; // JSON string[]
  estimatedSeconds?: number | null;
}

// Narrow shape instead of the full Prisma `Character` model.
export interface VoiceCharacterInput {
  id: string;
  name: string;
  gender?: string | null;
  voiceConfig?: string | null; // JSON-encoded CharacterVoiceConfig
}

export interface ComponentIssue { component: "voice" | "dialogue" | "casting" | "lipSync" | "render"; code: string; message: string; segmentId?: string }

export class VoiceStageError extends Error {
  constructor(message: string, public readonly code: string, public readonly retryable = false) { super(message); this.name = "VoiceStageError"; }
}

export interface VoiceStageDeps {
  db: {
    character: { update(args: { where: { id: string }; data: { voiceConfig: string } }): Promise<unknown> };
    scene: { update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown> };
    sceneAsset: { deleteMany(args: { where: Record<string, unknown> }): Promise<unknown>; create(args: { data: Record<string, unknown> }): Promise<unknown> };
    jobEvent?: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
  };
  store: BlobStore;
  keyFor: (projectId: string, cacheKey: string, ext: "mp3" | "meta.json") => string;
  tts: () => TTSProvider;
  env: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export interface VoiceStageOptions { fps?: number; jobId?: string; deps?: VoiceStageDeps; onProgress?: (fraction: number) => void | Promise<void> }
export interface VoiceStageResult {
  scenes: Array<{ sceneId: string; sceneNumber: number; timeline: SceneTimeline | null; issues: ComponentIssue[] }>;
  stats: { segments: number; synthesized: number; cached: number; failed: number };
}

async function defaultDeps(): Promise<VoiceStageDeps> {
  const [{ db }, storage, { ProviderFactory }, { logger }] = await Promise.all([
    import("@/lib/db"), import("@/lib/storage/objectStorage"), import("@/lib/ai/factory/provider-factory"), import("@/lib/logger"),
  ]);
  const exists = async (k: string) => storage.downloadObject(k).then(() => true, () => false);
  return {
    db: db as unknown as VoiceStageDeps["db"],
    store: { exists, get: (k) => storage.downloadObject(k), put: async (k, d, m) => { await storage.uploadObject(k, d, m); } },
    keyFor: (pid, ck, ext) => storage.projectStorageKey(pid, "dialogue", `${ck}.${ext}`),
    tts: () => ProviderFactory.getTTSProvider(),
    env: process.env,
    log: (l) => logger.info({ line: l }, "voice_stage"),
  };
}

const OPENAI_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
function voicePool(provider: string, env: NodeJS.ProcessEnv): VoicePoolEntry[] {
  if (env.VOICE_POOL_JSON) {
    const parsed = fromJson<VoicePoolEntry[]>(env.VOICE_POOL_JSON, []);
    return parsed.filter((v) => v && typeof v.voiceId === "string");
  }
  return provider === "openai" ? OPENAI_VOICES.map((voiceId) => ({ voiceId })) : [];
}

/**
 * Per-dialogue-segment voice generation + master timeline.
 *
 * - Every line is synthesised separately with ITS OWN speaker's persistent voice (never one track per scene,
 *   never the first speaker's voice for everyone). Narration is its own "narrator" segment.
 * - Characters without a voice are cast a distinct voice once (VOICE_POOL_JSON, or OpenAI's named voices) and the
 *   assignment is persisted on Character.voiceConfig so it never changes on regeneration.
 * - Emotion maps only to parameters the active provider supports; results are cached by a deterministic key,
 *   so re-running (or regenerating one scene) re-uses stored audio and spends no API credits.
 * - Durations are MEASURED from the decoded audio; the scene timeline is built AFTER this and stored in
 *   Scene.timeline (authoritative for animation, lip-sync, camera, SFX, subtitles and render).
 * - Failure policy: a missing/rejected API key fails the stage with a clear message; a single failed line is
 *   recorded in Scene.componentIssues and skipped (the rest of the project continues); if NOTHING could be
 *   synthesised the stage fails.
 */
export async function generateSceneVoices(
  projectId: string,
  scenes: VoiceSceneInput[],
  language: string,
  _voiceGender: "male" | "female" | "neutral",
  _voiceStyle: string,
  characters: VoiceCharacterInput[] = [],
  opts: VoiceStageOptions = {},
): Promise<VoiceStageResult> {
  const deps = opts.deps ?? (await defaultDeps());
  const log = deps.log ?? (() => undefined);
  const fps = opts.fps ?? Number(deps.env.RENDER_FPS || 24);
  const provider = deps.tts();
  const caps = provider.capabilities;
  if (!caps) throw new VoiceStageError(`TTS provider "${provider.name}" does not declare its capabilities.`, "VOICE_PROVIDER_INVALID");
  const event = async (message: string) => { await deps.db.jobEvent?.create({ data: { jobId: opts.jobId, stage: "voice", message } }).catch(() => undefined); };

  const defaultVoiceId = provider.name === "openai" ? deps.env.OPENAI_TTS_VOICE || "alloy" : deps.env.ELEVENLABS_DEFAULT_VOICE_ID || undefined;
  const cfgById = new Map<string, CharacterVoiceConfig>(characters.map((c) => [c.id, parseCharacterVoiceConfig(c.voiceConfig)]));

  // ---- persistent casting -------------------------------------------------
  const infos: CharacterInfo[] = characters.map((c) => {
    const cfg = cfgById.get(c.id) ?? {};
    const usable = !!cfg.voiceId && (!cfg.provider || cfg.provider === provider.name);
    return { id: c.id, name: c.name, gender: c.gender, defaultEmotion: normalizeEmotion(cfg.defaultEmotion), voice: usable ? { provider: provider.name, voiceId: cfg.voiceId! } : null };
  });
  const casting = castVoices(infos, provider.name, voicePool(provider.name, deps.env), defaultVoiceId ? { provider: provider.name, voiceId: defaultVoiceId } : null);
  const issuesGlobal: ComponentIssue[] = casting.warnings.map((message) => ({ component: "casting", code: "SHARED_OR_MISSING_VOICE", message }));
  for (const id of casting.newlyAssigned) {
    const v = casting.voices.get(id)!;
    const merged = { ...(cfgById.get(id) ?? {}), provider: provider.name, voiceId: v.voiceId };
    await deps.db.character.update({ where: { id }, data: { voiceConfig: toJson(merged) ?? "{}" } });
    cfgById.set(id, merged);
    log(`[CHARACTER] cast ${infos.find((c) => c.id === id)?.name} -> ${provider.name}:${v.voiceId} (persisted)`);
  }
  for (const c of infos) { const v = casting.voices.get(c.id); c.voice = v && v.voiceId !== defaultVoiceId ? v : (v ?? c.voice); }
  const narratorVoice: VoiceRef | null = (deps.env.NARRATOR_VOICE_ID || defaultVoiceId) ? { provider: provider.name, voiceId: (deps.env.NARRATOR_VOICE_ID || defaultVoiceId)! } : null;

  // ---- plan every scene's segments ------------------------------------------
  const plans = scenes.map((scene) => {
    const dialogue = fromJson<Array<{ character: string; line: string; emotion?: string; intensity?: number }>>(scene.dialogue, []);
    const { segments, issues } = planDialogueSegments({ sceneNumber: scene.sceneNumber, narration: scene.narration, dialogue, characters: infos, sceneMood: scene.mood, narratorVoice });
    return { scene, segments, issues };
  });
  const flat: PlannedSegment[] = plans.flatMap((p) => p.segments);
  const owner = new Map<PlannedSegment, number>(); plans.forEach((p, i) => p.segments.forEach((s) => owner.set(s, i)));

  const synth: VoiceSynth = {
    name: provider.name, capabilities: caps,
    async synthesize(req, signal) {
      const abort = new Promise<never>((_, rej) => signal.addEventListener("abort", () => rej(Object.assign(new Error("Provider call aborted (timeout)."), { name: "ProviderTimeoutError" }))));
      const g = await Promise.race([provider.synthesize({ text: req.text, language: req.language, voiceGender: "neutral", voiceStyle: "narrator", voiceId: req.voiceId, modelId: req.modelId, stability: req.stability, similarityBoost: req.similarityBoost, style: req.style, speed: req.speed, instructions: req.instructions, withTimestamps: req.withTimestamps }), abort]);
      return { audio: Buffer.from(g.audioBase64, "base64"), mimeType: g.mimeType, alignment: g.alignment, metadata: g.providerMetadata };
    },
  };
  const stats = { segments: flat.length, synthesized: 0, cached: 0, failed: 0 };
  const outcomes: SegmentOutcome[] = await synthesizeSegments({
    segments: flat, provider: synth, store: deps.store, language, log,
    keyFor: (ck, ext) => deps.keyFor(projectId, ck, ext),
    concurrency: Number(deps.env.VOICE_CONCURRENCY || 3),
    useTimestamps: provider.name === "elevenlabs" && deps.env.ELEVENLABS_USE_TIMESTAMPS === "true",
    settingsFor: (seg) => {
      const cfg = (seg.characterId && cfgById.get(seg.characterId)) || {};
      const r = resolveCharacterVoice(cfg, { defaultVoiceId, defaultModelId: provider.name === "elevenlabs" ? deps.env.ELEVENLABS_MODEL_ID : deps.env.OPENAI_TTS_MODEL });
      return { voiceId: defaultVoiceId, modelId: provider.name === "elevenlabs" || provider.name === "openai" ? (cfg.modelId || (provider.name === "openai" ? deps.env.OPENAI_TTS_MODEL : r.modelId)) || undefined : undefined, base: { stability: r.stability, similarityBoost: r.similarityBoost, style: r.style, speed: r.speed }, lexicon: cfg.pronunciation ?? null };
    },
    onSegmentDone: (d, t) => { void opts.onProgress?.(t ? (d / t) * 0.9 : 0.9); },
  });

  const fatal = outcomes.find((o) => !o.ok && (o.error.code === "NOT_CONFIGURED" || o.error.code === "AUTH"));
  if (fatal && !fatal.ok) throw new VoiceStageError(fatal.error.message, fatal.error.code === "AUTH" ? "PROVIDER_AUTH_FAILED" : "PROVIDER_NOT_CONFIGURED", false);
  for (const o of outcomes) { if (o.ok) { if (o.cached) stats.cached++; else stats.synthesized++; } else stats.failed++; }
  if (flat.length > 0 && stats.failed === flat.length) {
    const first = outcomes.find((o) => !o.ok)!;
    throw new VoiceStageError(`Voice generation failed for every line: ${(first as { error: { message: string } }).error.message}`, "VOICE_GENERATION_FAILED", true);
  }

  // ---- per scene: persist assets, build + persist the master timeline ----------
  const result: VoiceStageResult = { scenes: [], stats };
  for (const [i, p] of plans.entries()) {
    const scene = p.scene;
    const sceneOutcomes = flat.map((s, k) => ({ s, o: outcomes[k]! })).filter((x) => owner.get(x.s) === i);
    const issues: ComponentIssue[] = [
      ...issuesGlobal,
      ...p.issues.filter((x: SegmentIssue) => x.code !== "LINE_SPLIT").map((x) => ({ component: "dialogue" as const, code: x.code, message: x.message, segmentId: x.segmentId })),
    ];
    const ok = sceneOutcomes.filter((x) => x.o.ok).map((x) => x.o as Extract<SegmentOutcome, { ok: true }>);
    for (const x of sceneOutcomes) if (!x.o.ok) issues.push({ component: "voice", code: x.o.error.code, message: `${x.s.speakerName}: ${x.o.error.message} - line skipped; regenerate the voice to retry.`, segmentId: x.s.segmentId });

    await deps.db.sceneAsset.deleteMany({ where: { sceneId: scene.id, type: "DIALOGUE_AUDIO" } });
    for (const o of ok) await deps.db.sceneAsset.create({ data: { sceneId: scene.id, type: "DIALOGUE_AUDIO", storageKey: o.audio.storageKey, providerName: provider.name,
      providerMetadata: toJson({ segmentId: o.segment.segmentId, characterId: o.segment.characterId, speakerName: o.segment.speakerName, emotion: o.segment.emotion, intensity: o.segment.intensity, voiceId: o.segment.voice?.voiceId ?? defaultVoiceId ?? null, cacheKey: o.audio.cacheKey, durationSeconds: o.audio.durationSeconds, cached: o.cached, ignoredParams: o.ignoredParams }) } });

    const spoken = ok.map((o) => o.segment.characterId).filter((id) => infos.some((c) => c.id === id));
    const listed = fromJson<string[]>(scene.characterIds, []).filter((id) => infos.some((c) => c.id === id));
    const onScreen = [...new Set([...listed, ...spoken])];
    const tl = buildSceneTimeline({
      sceneId: scene.id, sceneNumber: scene.sceneNumber, fps, language, onScreen,
      plannedSeconds: scene.estimatedSeconds ?? null,
      sceneText: [scene.description, scene.mood, scene.location, scene.cameraAngle, scene.cameraMovement].filter(Boolean).join(" "),
      sfxHints: fromJson<string[]>(scene.soundEffects, []), musicMood: scene.musicMood ?? null,
      isFirstScene: i === 0, isLastScene: i === scenes.length - 1,
      segments: ok.map((o) => ({ planned: o.segment, audio: o.audio, envelope: o.envelope })),
    });
    const bad = validateTimeline(tl);
    if (bad.length) throw new VoiceStageError(`Scene ${scene.sceneNumber} timeline is inconsistent: ${bad.slice(0, 3).join("; ")}`, "TIMELINE_INVALID");
    for (const w of tl.warnings) issues.push({ component: "dialogue", code: "TIMELINE_WARNING", message: w });

    await deps.db.scene.update({ where: { id: scene.id }, data: { timeline: toJson(tl), estimatedSeconds: Math.ceil(tl.duration), componentIssues: toJson(issues) } });
    result.scenes.push({ sceneId: scene.id, sceneNumber: scene.sceneNumber, timeline: tl, issues });
    log(`[SCENE] ${scene.sceneNumber}: timeline ${tl.duration.toFixed(3)}s (${tl.durationSource}), ${tl.segments.length} segment(s), ${issues.length} issue(s)`);
    await opts.onProgress?.(0.9 + ((i + 1) / plans.length) * 0.1);
  }
  if (stats.failed > 0) await event(`Voice: ${stats.failed} of ${stats.segments} line(s) could not be generated and were skipped (see the scene's component issues).`);
  await event(`Voice: ${stats.synthesized} synthesized, ${stats.cached} reused from cache.`);
  return result;
}
