import type { LipSyncProvider } from "@/lib/ai/interfaces/lipsync-provider";
import { fromJson, toJson } from "@/lib/domain/json";
import { hashParts } from "@/lib/engine/cacheKey";
import { planSceneLipSync } from "@/lib/engine/lipsyncPlan";
import type { LipSyncPlan } from "@/lib/engine/lipsyncPlan";
import { withRetry } from "@/lib/engine/retry";
import type { SceneTimeline } from "@/lib/engine/types";
import type { ComponentIssue } from "@/lib/pipeline/voiceStage";

/**
 * Lip-sync stage.
 *
 * The VISEME timeline (audio-derived mouth shapes) already exists on every scene's master timeline - the voice
 * stage builds it from the measured audio. This stage decides how that becomes visible in the final video and
 * reports it honestly (see planSceneLipSync):
 *
 *  - "rig"            speakers have layered rigs: the renderer composites mouths from the timeline (nothing to do here)
 *  - "provider-video" ONE speaker + provider configured: the ANIMATED SCENE CLIP (not a portrait) plus that speaker's
 *                     own dialogue audio go to a video-to-video lip-sync provider; body, camera and background of the
 *                     scene are preserved. The clip is stored as LIP_SYNC_CLIP and used as the video source at render.
 *  - "visemes-only"   no mouth animation is applied to the video. The reason is recorded ("Lip-sync provider is not
 *                     configured...", "multi-speaker scene ..."), never reported as success.
 *
 * A talking head generated from a static reference image is NEVER pasted over the scene. Provider failures are
 * recorded per scene (Scene.componentIssues) and the plain animated clip is used instead - the job continues.
 */
export interface LipSyncSceneInput { id: string; sceneNumber: number; timeline: string | null; componentIssues?: string | null }
export interface LipSyncCharacterInput { id: string; name: string; providerMetadata?: string | null }

export interface LipSyncStageDeps {
  db: {
    scene: { update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown> };
    sceneAsset: {
      findMany(args: { where: Record<string, unknown>; orderBy?: Record<string, string> }): Promise<Array<{ storageKey: string; providerMetadata: string | null; type: string }>>;
      deleteMany(args: { where: Record<string, unknown> }): Promise<unknown>;
      create(args: { data: Record<string, unknown> }): Promise<unknown>;
    };
    jobEvent?: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
  };
  store: { get(key: string): Promise<Buffer>; put(key: string, data: Buffer, mime: string): Promise<void>; key(projectId: string, ...parts: string[]): string };
  provider: () => LipSyncProvider;
  configured: () => boolean;
  enabled: () => boolean;
  /** Renders ONE speaker's dialogue, positioned on the scene timeline (silence elsewhere), as a WAV. */
  buildSpeakerStem: (tl: SceneTimeline, speakerId: string, files: Record<string, Buffer>) => Promise<Buffer>;
  /** Confirms the provider output is a real video and reports its duration. */
  validateClip: (data: Buffer) => Promise<{ ok: boolean; durationSeconds: number; reason?: string }>;
  sleep: (ms: number) => Promise<void>;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  maxDurationDriftSec: number;
  retry?: { retries?: number; baseDelayMs?: number };
  log?: (line: string) => void;
}

export interface LipSyncStageResult { plans: LipSyncPlan[]; applied: number; failed: number }

async function defaultDeps(): Promise<LipSyncStageDeps> {
  const [{ db }, storage, { ProviderFactory }, { logger }, engine] = await Promise.all([
    import("@/lib/db"), import("@/lib/storage/objectStorage"), import("@/lib/ai/factory/provider-factory"), import("@/lib/logger"), import("@/lib/engine/stemTools"),
  ]);
  const env = process.env;
  return {
    db: db as unknown as LipSyncStageDeps["db"],
    store: { get: (k) => storage.downloadObject(k), put: async (k, d, m) => { await storage.uploadObject(k, d, m); }, key: (pid, ...parts) => storage.projectStorageKey(pid, ...parts) },
    provider: () => ProviderFactory.getLipSyncProvider(),
    configured: () => !!env.LIPSYNC_PROVIDER?.trim() && !!env.LIPSYNC_PROVIDER_API_KEY && !!env.LIPSYNC_PROVIDER_BASE_URL,
    enabled: () => env.ENABLE_LIPSYNC !== "false",
    buildSpeakerStem: engine.buildSpeakerStem, validateClip: engine.validateVideoBuffer,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    pollIntervalMs: 5000, pollTimeoutMs: 10 * 60 * 1000, maxDurationDriftSec: 1.5,
    log: (l) => logger.info({ line: l }, "lipsync_stage"),
  };
}

/** Only what invalidates a provider result: who speaks, which audio, when, and which source clip. */
function lipSyncFingerprint(tl: SceneTimeline, speakerId: string, sourceKey: string): string {
  return hashParts({ v: 1, speakerId, sourceKey, duration: tl.duration, segments: tl.segments.filter((s) => s.characterId === speakerId).map((s) => [s.segmentId, s.audio.cacheKey, s.startTime, s.endTime]) });
}

export async function generateSceneLipSync(
  projectId: string, scenes: LipSyncSceneInput[], characters: LipSyncCharacterInput[], jobId?: string,
  opts: { deps?: LipSyncStageDeps; onProgress?: (fraction: number) => void | Promise<void> } = {},
): Promise<LipSyncStageResult> {
  const deps = opts.deps ?? (await defaultDeps());
  const log = deps.log ?? (() => undefined);
  const event = async (message: string) => { await deps.db.jobEvent?.create({ data: { jobId, stage: "lip_sync", message } }).catch(() => undefined); };
  const providerOn = deps.enabled() && deps.configured();
  const rigIds = characters.filter((c) => !!fromJson<{ rig?: unknown }>(c.providerMetadata, {}).rig).map((c) => c.id);
  const result: LipSyncStageResult = { plans: [], applied: 0, failed: 0 };

  for (const [i, scene] of scenes.entries()) {
    const tl = fromJson<SceneTimeline | null>(scene.timeline, null);
    if (!tl) { await event(`Scene ${scene.sceneNumber}: no master timeline yet - lip-sync skipped.`); continue; }
    const assets = await deps.db.sceneAsset.findMany({ where: { sceneId: scene.id, type: { in: ["VIDEO_CLIP", "LIP_SYNC_CLIP", "DIALOGUE_AUDIO"] } }, orderBy: { createdAt: "desc" } });
    const clip = assets.find((a) => a.type === "VIDEO_CLIP");
    const plan = planSceneLipSync(tl, { providerConfigured: providerOn, hasVideoClip: !!clip, rigCharacterIds: rigIds });
    result.plans.push(plan);
    const issues: ComponentIssue[] = fromJson<ComponentIssue[]>(scene.componentIssues, []).filter((x) => x.component !== "lipSync");
    let applied = plan.appliedToVideo;

    if (plan.mode === "provider-video" && clip) {
      const speakerId = plan.speakers[0]!;
      const fp = lipSyncFingerprint(tl, speakerId, clip.storageKey);
      const existing = assets.find((a) => a.type === "LIP_SYNC_CLIP" && fromJson<{ fingerprint?: string }>(a.providerMetadata, {}).fingerprint === fp);
      if (existing) log(`[LIP-SYNC] scene ${scene.sceneNumber}: up to date (fingerprint match) - reusing stored clip`);
      else {
        await deps.db.sceneAsset.deleteMany({ where: { sceneId: scene.id, type: "LIP_SYNC_CLIP" } });
        try {
          const out = await runProvider(deps, projectId, scene, tl, speakerId, clip.storageKey, assets.filter((a) => a.type === "DIALOGUE_AUDIO"), fp, log);
          await deps.db.sceneAsset.create({ data: { sceneId: scene.id, type: "LIP_SYNC_CLIP", storageKey: out.key, providerName: deps.provider().name, providerJobId: out.jobId, providerMetadata: toJson({ fingerprint: fp, speakerId, mode: "provider-video", durationSeconds: out.duration }) } });
          await event(`Scene ${scene.sceneNumber}: lip-synced ${speakerId} via ${deps.provider().name} (video-to-video).`);
        } catch (err) {
          applied = false; result.failed++;
          const message = err instanceof Error ? err.message : String(err);
          issues.push({ component: "lipSync", code: "LIPSYNC_FAILED", message: `Lip-sync provider failed for scene ${scene.sceneNumber}: ${message}. The un-lip-synced animated clip is used; regenerate lip-sync to retry.` });
          await event(`Scene ${scene.sceneNumber}: lip-sync failed (${message}) - using the plain animated clip.`);
        }
      }
    } else {
      // Not (or no longer) a provider scene: a stale provider clip from an earlier run must not be used.
      await deps.db.sceneAsset.deleteMany({ where: { sceneId: scene.id, type: "LIP_SYNC_CLIP" } });
    }
    if (applied) result.applied++;
    issues.push({ component: "lipSync", code: plan.mode.toUpperCase().replace("-", "_") + (applied ? "" : "_NOT_APPLIED"), message: plan.reason });
    await deps.db.scene.update({ where: { id: scene.id }, data: { componentIssues: toJson(issues) } });
    await opts.onProgress?.((i + 1) / scenes.length);
  }
  const notApplied = result.plans.filter((p) => p.mode !== "none" && !p.appliedToVideo).length;
  if (notApplied > 0) await event(`Lip-sync: ${notApplied} scene(s) have a viseme timeline but no mouth animation applied to the video (${providerOn ? "see each scene's reason" : "Lip-sync provider is not configured"}).`);
  return result;
}

async function runProvider(deps: LipSyncStageDeps, projectId: string, scene: LipSyncSceneInput, tl: SceneTimeline, speakerId: string, clipKey: string,
  dialogueAssets: Array<{ storageKey: string; providerMetadata: string | null }>, fingerprint: string, log: (l: string) => void) {
  const provider = deps.provider();
  const video = await deps.store.get(clipKey);
  const files: Record<string, Buffer> = {};
  for (const a of dialogueAssets) { const meta = fromJson<{ segmentId?: string }>(a.providerMetadata, {}); if (meta.segmentId) files[meta.segmentId] = await deps.store.get(a.storageKey); }
  const audio = await deps.buildSpeakerStem(tl, speakerId, files); // ONLY this speaker's lines, placed on the scene timeline
  const retry = { retries: deps.retry?.retries ?? 2, baseDelayMs: deps.retry?.baseDelayMs ?? 1500, sleep: deps.sleep, timeoutMs: 120_000, onRetry: (i: { attempt: number; maxAttempts: number; delayMs: number }) => log(`[LIP-SYNC] scene ${scene.sceneNumber} Retry ${i.attempt}/${i.maxAttempts - 1} in ${i.delayMs}ms`) };
  // Video-to-video: the animated clip is the input. There is deliberately NO imageBase64 (portrait) path.
  const handle = await withRetry(() => provider.submit({ videoBase64: video.toString("base64"), audioBase64: audio.toString("base64"), audioMimeType: "audio/wav", characterName: speakerId }), retry);
  const deadline = Date.now() + deps.pollTimeoutMs;
  for (;;) {
    const st = await withRetry(() => provider.getStatus(handle.providerJobId), retry);
    if (st.status === "completed") {
      if (!st.videoBase64) throw new Error("Provider reported completed but returned no video.");
      const buf = Buffer.from(st.videoBase64, "base64");
      const v = await deps.validateClip(buf);
      if (!v.ok) throw new Error(`Provider output failed validation (${v.reason ?? "invalid video"}).`);
      // Providers often return fixed-length clips; the renderer trims a longer clip to the audio-derived scene length.
      // A clip much SHORTER than the scene would freeze the mouth for the remainder (last-frame hold), so that - and
      // near-empty or absurdly long output - is rejected.
      const minOk = Math.max(0.5, tl.duration * 0.5), maxOk = Math.max(tl.duration * 3, tl.duration + deps.maxDurationDriftSec);
      if (v.durationSeconds < minOk || v.durationSeconds > maxOk) throw new Error(`Provider output is ${v.durationSeconds.toFixed(1)}s for a ${tl.duration.toFixed(1)}s scene (accepted range ${minOk.toFixed(1)}-${maxOk.toFixed(1)}s).`);
      const key = deps.store.key(projectId, "scenes", `${scene.sceneNumber}`, `lipsync-${fingerprint.slice(0, 12)}.mp4`);
      await deps.store.put(key, buf, st.mimeType || "video/mp4");
      return { key, jobId: handle.providerJobId, duration: v.durationSeconds };
    }
    if (st.status === "failed" || st.status === "cancelled") throw new Error(st.errorMessage || `Provider job ${st.status}.`);
    if (Date.now() > deadline) { await provider.cancel?.(handle.providerJobId).catch(() => undefined); throw new Error("Timed out waiting for the lip-sync provider."); }
    await deps.sleep(deps.pollIntervalMs);
  }
}
