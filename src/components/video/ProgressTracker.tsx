const STAGES: { key: string; label: string }[] = [
  { key: "story_analysis", label: "Story analyzed" },
  { key: "characters", label: "Characters created" },
  { key: "storyboard", label: "Scenes created" },
  { key: "animation", label: "Generating animation" },
  { key: "voice", label: "Voice generation" },
  { key: "lip_sync", label: "Lip-syncing dialogue" },
  { key: "music", label: "Music & sound effects" },
  { key: "subtitles", label: "Subtitles" },
  { key: "rendering", label: "Final rendering" },
];

export function ProgressTracker({
  currentStage,
  status,
  musicFallback = false,
  lipSynced = false,
}: {
  currentStage: string | null;
  status: string;
  /** True if music & sound effects were produced by the free local FFmpeg
   * fallback (e.g. the paid provider was unconfigured or out of balance)
   * rather than the primary AI provider - shown as a suffix on that stage's
   * label so the switch is transparent, never a silent "failure". */
  musicFallback?: boolean;
  /** True if at least one scene actually got a real lip-synced clip. False
   * (the default when LIPSYNC_PROVIDER is unset) shows a suffix explaining
   * the base animation clips were kept as-is, rather than silently implying
   * lip sync happened. */
  lipSynced?: boolean;
}) {
  const currentIndex = STAGES.findIndex((s) => s.key === currentStage);
  const isActive = status === "PROCESSING" || status === "RETRYING";

  return (
    <div className="space-y-4">
      {status === "QUEUED" && (
        <p className="text-sm text-paper/60">Waiting for a worker to pick this up...</p>
      )}
      {status === "RETRYING" && (
        <p className="text-sm text-lantern-400">
          A step hit a temporary error and is being retried automatically.
        </p>
      )}
      {status === "CANCEL_REQUESTED" && (
        <p className="text-sm text-lantern-400">Cancelling - finishing the current step, then stopping...</p>
      )}
      {status === "CANCELLED" && <p className="text-sm text-paper/60">Generation was cancelled.</p>}

      <div className="space-y-3">
        {STAGES.map((stage, i) => {
          const isDone = status === "COMPLETED" || (currentIndex >= 0 && i < currentIndex);
          const isCurrent = i === currentIndex && isActive;
          const isFailed = status === "FAILED" && i === currentIndex;

          return (
            <div key={stage.key} className="flex items-center gap-3 text-sm">
              <span
                className={
                  isFailed
                    ? "text-red-400"
                    : isDone
                      ? "text-moon-400"
                      : isCurrent
                        ? "text-lantern-400"
                        : "text-paper/30"
                }
              >
                {isFailed ? "✕" : isDone ? "✓" : isCurrent ? "⏳" : "○"}
              </span>
              <span className={isDone || isCurrent ? "text-paper" : "text-paper/40"}>
                {stage.label}
                {stage.key === "music" && musicFallback && isDone && (
                  <span className="text-paper/50"> (local fallback)</span>
                )}
                {stage.key === "lip_sync" && !lipSynced && isDone && (
                  <span className="text-paper/50"> (no provider configured)</span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
