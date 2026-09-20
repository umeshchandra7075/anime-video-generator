// SQLite (used for local dev) has no native enum column type, so every
// "enum" in the schema is a plain String column. These constants are the
// single source of truth for allowed values across the whole app - both
// backend and frontend import from here instead of hardcoding string
// literals, so a typo becomes a compile error instead of a silent bug.

export const Role = { USER: "USER", ADMIN: "ADMIN" } as const;
export type RoleValue = (typeof Role)[keyof typeof Role];

export const ProjectStatus = {
  DRAFT: "DRAFT",
  QUEUED: "QUEUED",
  PROCESSING: "PROCESSING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
} as const;
export type ProjectStatusValue = (typeof ProjectStatus)[keyof typeof ProjectStatus];

export const SceneStatus = {
  PENDING: "PENDING",
  PROCESSING: "PROCESSING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  SKIPPED: "SKIPPED",
} as const;
export type SceneStatusValue = (typeof SceneStatus)[keyof typeof SceneStatus];

export const AssetType = {
  IMAGE: "IMAGE",
  VIDEO_CLIP: "VIDEO_CLIP",
  VOICE_AUDIO: "VOICE_AUDIO",
  // Produced by lipSyncStage.ts when LIPSYNC_PROVIDER is configured: the
  // scene's VIDEO_CLIP/character portrait redriven by its VOICE_AUDIO
  // track through a real audio-to-viseme lip-sync provider. Optional -
  // compositeStage.ts prefers this over VIDEO_CLIP when present, and falls
  // back to VIDEO_CLIP unchanged when it isn't.
  LIP_SYNC_CLIP: "LIP_SYNC_CLIP",
} as const;

// The full durable job state machine. Transitions enforced in
// src/lib/pipeline/jobTracking.ts and the worker - not just documented here.
//
//   QUEUED --------> PROCESSING ------> COMPLETED
//     ^                  |  ^  \
//     |    (heartbeat    |  |   \---> CANCEL_REQUESTED -> CANCELLED
//     |     timeout or   |  |
//     |     transient    v  |
//     +------------ RETRYING
//     |
//     +------------------------------> FAILED  (attempts exhausted / fatal error)
export const JobStatus = {
  QUEUED: "QUEUED",
  PROCESSING: "PROCESSING",
  RETRYING: "RETRYING",
  CANCEL_REQUESTED: "CANCEL_REQUESTED",
  CANCELLED: "CANCELLED",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
} as const;
export type JobStatusValue = (typeof JobStatus)[keyof typeof JobStatus];

export const TERMINAL_JOB_STATUSES: JobStatusValue[] = [
  JobStatus.COMPLETED,
  JobStatus.FAILED,
  JobStatus.CANCELLED,
];

export const ACTIVE_JOB_STATUSES: JobStatusValue[] = [
  JobStatus.QUEUED,
  JobStatus.PROCESSING,
  JobStatus.RETRYING,
  JobStatus.CANCEL_REQUESTED,
];

export function isTerminalJobStatus(status: string): boolean {
  return (TERMINAL_JOB_STATUSES as string[]).includes(status);
}
