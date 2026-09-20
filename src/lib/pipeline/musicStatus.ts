import { db } from "@/lib/db";

/**
 * Whether the project's MUSIC AudioAsset (if any) was produced by the local
 * FFmpeg fallback rather than the primary paid provider - used by the
 * status endpoints so the progress UI can show "Music & sound effects
 * (local fallback)" instead of a plain checkmark.
 */
export async function isLocalMusicFallback(projectId: string): Promise<boolean> {
  const musicAsset = await db.audioAsset.findFirst({
    where: { projectId, type: "MUSIC" },
    select: { providerName: true },
  });
  return musicAsset?.providerName === "local-ffmpeg-fallback";
}
