"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { api, ApiRequestError } from "@/lib/api/client";
import { AppNavbar } from "@/components/app/AppNavbar";
import { ProgressTracker } from "@/components/video/ProgressTracker";
import { Storyboard, SceneSummary } from "@/components/video/Storyboard";
import { VideoPlayer } from "@/components/video/VideoPlayer";
import { LoadingSkeleton, ErrorState } from "@/components/ui/States";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";

interface ProjectDetail {
  id: string;
  title: string;
  status: string;
}

interface StatusPayload {
  status: string;
  currentStage: string | null;
  progress: number;
  errorCode: string | null;
  errorMessage: string | null;
  musicFallback?: boolean;
  lipSynced?: boolean;
}

const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
const POLL_FALLBACK_MS = 5000; // always-on safety net alongside SSE, not just a failure fallback

const STAGE_MESSAGES: Record<string, string> = {
  story_analysis: "Generating your story script...",
  characters: "Generating anime characters...",
  storyboard: "Generating anime scenes...",
  animation: "Generating scene artwork...",
  voice: "Generating voice narration...",
  lip_sync: "Synchronizing character lip movement...",
  music: "Generating music & sound effects...",
  subtitles: "Creating subtitles...",
  rendering: "Rendering your final video...",
};

function announceTransition(payload: StatusPayload, show: (msg: string, variant?: "success" | "error" | "info") => void) {
  if (payload.status === "COMPLETED") {
    show("Video generated successfully! 🎉", "success");
    return;
  }
  if (payload.status === "FAILED") {
    show(payload.errorMessage || "Video generation failed. Please try again.", "error");
    return;
  }
  if (payload.status === "CANCELLED") {
    show("Video generation cancelled.", "info");
    return;
  }
  if (payload.status === "RETRYING") {
    show("Retrying video generation...", "info");
    return;
  }
  if (payload.currentStage && STAGE_MESSAGES[payload.currentStage]) {
    show(STAGE_MESSAGES[payload.currentStage]!, "info");
  }
}

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const { show } = useToast();

  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [scenes, setScenes] = useState<SceneSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connection, setConnection] = useState<"connecting" | "live" | "polling">("connecting");
  const [cancelling, setCancelling] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadProject = useCallback(() => {
    api
      .get<ProjectDetail>(`/api/projects/${projectId}`)
      .then((p) => {
        setProject(p);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiRequestError ? err.message : "Could not load project."));
  }, [projectId]);

  const loadScenes = useCallback(() => {
    api
      .get<SceneSummary[]>(`/api/projects/${projectId}/scenes`)
      .then(setScenes)
      .catch(() => {});
  }, [projectId]);

  const applyStatus = useCallback(
    (payload: StatusPayload) => {
      setStatus((prev) => {
        // Fire a toast only on genuine stage/status transitions, never on
        // every poll tick - otherwise the same "Generating animation..."
        // toast would spam on each 2-5s refresh.
        if (!prev || prev.status !== payload.status || prev.currentStage !== payload.currentStage) {
          announceTransition(payload, show);
        }
        return payload;
      });
      loadScenes();
      if (TERMINAL_STATUSES.has(payload.status)) loadProject();
    },
    [loadScenes, loadProject, show],
  );

  const pollOnce = useCallback(() => {
    api
      .get<{ job: StatusPayload | null }>(`/api/projects/${projectId}/status`)
      .then((data) => {
        if (data.job) applyStatus(data.job);
      })
      .catch(() => {});
  }, [projectId, applyStatus]);

  useEffect(() => {
    loadProject();
    loadScenes();
  }, [loadProject, loadScenes]);

  // Always-on low-frequency polling safety net, independent of SSE health -
  // covers the case where a connection silently stalls (e.g. an idle proxy
  // timeout) without ever firing an error event.
  useEffect(() => {
    const interval = setInterval(() => {
      if (!status || !TERMINAL_STATUSES.has(status.status)) pollOnce();
    }, POLL_FALLBACK_MS);
    return () => clearInterval(interval);
  }, [pollOnce, status]);

  // Real-time SSE with reconnect-with-backoff. Falls back to relying on the
  // polling safety net above if reconnection keeps failing.
  useEffect(() => {
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      const es = new EventSource(`/api/projects/${projectId}/status/stream`);
      eventSourceRef.current = es;

      es.addEventListener("status", (e) => {
        reconnectAttemptsRef.current = 0;
        setConnection("live");
        applyStatus(JSON.parse((e as MessageEvent).data));
      });
      es.addEventListener("done", () => {
        es.close();
      });
      es.onerror = () => {
        es.close();
        if (cancelled) return;
        reconnectAttemptsRef.current += 1;
        setConnection(reconnectAttemptsRef.current > 3 ? "polling" : "connecting");
        const delay = Math.min(15000, 1000 * 2 ** reconnectAttemptsRef.current);
        reconnectTimerRef.current = setTimeout(connect, delay);
      };
    }

    connect();
    return () => {
      cancelled = true;
      eventSourceRef.current?.close();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
  }, [projectId, applyStatus]);

  async function cancelGeneration() {
    setCancelling(true);
    try {
      const result = await api.post<{ status: string }>(`/api/projects/${projectId}/cancel`);
      show(
        result.status === "CANCELLED" ? "Generation cancelled." : "Cancellation requested - stopping shortly.",
        "success",
      );
      pollOnce();
    } catch (err) {
      show(err instanceof ApiRequestError ? err.message : "Could not cancel.", "error");
    } finally {
      setCancelling(false);
    }
  }

  if (loadError) {
    return (
      <main className="min-h-screen bg-ink-950">
        <AppNavbar />
        <div className="mx-auto max-w-3xl px-6 py-12">
          <ErrorState message={loadError} onRetry={loadProject} />
        </div>
      </main>
    );
  }

  if (!project) {
    return (
      <main className="min-h-screen bg-ink-950">
        <AppNavbar />
        <div className="mx-auto max-w-3xl space-y-4 px-6 py-12">
          <LoadingSkeleton className="h-10 w-2/3" />
          <LoadingSkeleton className="h-64 w-full" />
        </div>
      </main>
    );
  }

  const currentStatus = status?.status ?? project.status;
  const isTerminal = TERMINAL_STATUSES.has(currentStatus);
  const canCancel = ["QUEUED", "PROCESSING", "RETRYING"].includes(currentStatus);

  return (
    <main className="min-h-screen bg-ink-950">
      <AppNavbar />
      <div className="mx-auto max-w-4xl px-6 py-12">
        <div className="flex items-start justify-between gap-4">
          <h1 className="font-display text-3xl text-paper">{project.title}</h1>
          {!isTerminal && (
            <span
              className={`shrink-0 rounded-full border px-2.5 py-1 text-xs ${
                connection === "live"
                  ? "border-moon-500/40 text-moon-400"
                  : "border-lantern-500/40 text-lantern-400"
              }`}
              title={connection === "polling" ? "Live updates unavailable - falling back to periodic refresh" : undefined}
            >
              {connection === "live" ? "Live" : connection === "polling" ? "Reconnecting..." : "Connecting..."}
            </span>
          )}
        </div>

        {currentStatus === "COMPLETED" ? (
          <div className="mt-8">
            <VideoPlayer projectId={project.id} title={project.title} />
          </div>
        ) : (
          <div className="mt-8 rounded-sm border border-ink-700 bg-ink-900 p-6">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg text-paper">Generation progress</h2>
              {canCancel && (
                <Button
                  variant="danger"
                  className="!px-4 !py-1.5 text-xs"
                  onClick={cancelGeneration}
                  disabled={cancelling || currentStatus === "CANCEL_REQUESTED"}
                >
                  {currentStatus === "CANCEL_REQUESTED"
                    ? "Cancelling..."
                    : cancelling
                      ? "Cancelling..."
                      : "Cancel"}
                </Button>
              )}
            </div>
            <div className="mt-5">
              <ProgressTracker
                currentStage={status?.currentStage ?? null}
                status={currentStatus}
                musicFallback={status?.musicFallback ?? false}
                lipSynced={status?.lipSynced ?? false}
              />
            </div>
            {currentStatus === "FAILED" && (
              <div className="mt-4 rounded-sm border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-300">
                <p className="font-semibold">{status?.errorCode}</p>
                <p className="mt-1">{status?.errorMessage}</p>
              </div>
            )}
          </div>
        )}

        {scenes.length > 0 && !isTerminal && (
          <div className="mt-10">
            <h2 className="font-display text-lg text-paper">Storyboard</h2>
            <div className="mt-4">
              <Storyboard scenes={scenes} onChanged={loadScenes} />
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
