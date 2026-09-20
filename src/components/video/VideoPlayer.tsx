"use client";

import { useEffect, useState } from "react";
import { api, ApiRequestError } from "@/lib/api/client";
import { Button } from "@/components/ui/Button";
import { LoadingSkeleton, ErrorState } from "@/components/ui/States";

interface VideoInfo {
  url: string;
  durationSeconds: number | null;
  resolution: string | null;
  format: string;
}

export function VideoPlayer({ projectId, title }: { projectId: string; title: string }) {
  const [video, setVideo] = useState<VideoInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<VideoInfo>(`/api/projects/${projectId}/video`)
      .then(setVideo)
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load video."));
  }, [projectId]);

  async function download() {
    const data = await api.get<{ video: { url: string }; subtitles: { url: string; language: string }[] }>(
      `/api/projects/${projectId}/download`,
    );
    window.open(data.video.url, "_blank");
  }

  if (error) return <ErrorState message={error} />;
  if (!video) return <LoadingSkeleton className="aspect-video w-full" />;

  return (
    <div>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- subtitle track is provided as a separate download; burned/soft tracks vary per render */}
      <video src={video.url} controls className="w-full rounded-sm border border-ink-700 bg-black" />
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-paper/60">
        <span>
          {title} · {video.resolution ?? "—"}
          {video.durationSeconds ? ` · ${Math.round(video.durationSeconds)}s` : ""}
        </span>
        <div className="flex gap-3">
          <Button variant="secondary" onClick={download}>
            Download video
          </Button>
        </div>
      </div>
    </div>
  );
}
