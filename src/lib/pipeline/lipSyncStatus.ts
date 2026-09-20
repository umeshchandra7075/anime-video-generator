import { db } from "@/lib/db";

/**
 * Whether lip sync actually ran for this project (i.e. at least one scene
 * has a LIP_SYNC_CLIP asset) - used by the status endpoints so the progress
 * UI can show "Lip-syncing dialogue (no provider configured)" instead of a
 * plain checkmark when LIPSYNC_PROVIDER was unset and lipSyncStage.ts
 * skipped the project entirely. Mirrors isLocalMusicFallback in
 * musicStatus.ts.
 */
export async function didProjectGetLipSync(projectId: string): Promise<boolean> {
  const count = await db.sceneAsset.count({
    where: { type: "LIP_SYNC_CLIP", scene: { projectId } },
  });
  return count > 0;
}
