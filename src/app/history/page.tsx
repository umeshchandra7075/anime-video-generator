"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, ApiRequestError } from "@/lib/api/client";
import { AppNavbar } from "@/components/app/AppNavbar";
import { LoadingSkeleton, ErrorState, EmptyState } from "@/components/ui/States";

interface HistoryEntry {
  id: string;
  status: string;
  currentStage: string | null;
  progress: number;
  errorCode: string | null;
  errorMessage: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  project: { id: string; title: string; duration: string; animeStyle: string };
}

const statusStyles: Record<string, string> = {
  QUEUED: "text-paper/50 border-ink-600",
  PROCESSING: "text-lantern-400 border-lantern-500/40",
  RETRYING: "text-lantern-400 border-lantern-500/40",
  CANCEL_REQUESTED: "text-lantern-400 border-lantern-500/40",
  CANCELLED: "text-paper/50 border-ink-600",
  COMPLETED: "text-moon-400 border-moon-500/40",
  FAILED: "text-red-300 border-red-500/40",
};

export default function HistoryPage() {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setError(null);
    api
      .get<{ items: HistoryEntry[] }>("/api/history")
      .then((data) => setEntries(data.items))
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load history."));
  }

  useEffect(load, []);

  return (
    <main className="min-h-screen bg-ink-950">
      <AppNavbar />
      <div className="mx-auto max-w-4xl px-6 py-12">
        <h1 className="font-display text-3xl text-paper">Generation history</h1>

        {error && (
          <div className="mt-8">
            <ErrorState message={error} onRetry={load} />
          </div>
        )}

        {!error && !entries && (
          <div className="mt-8 space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <LoadingSkeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        )}

        {entries && entries.length === 0 && (
          <div className="mt-8">
            <EmptyState title="No generations yet" body="Your generation history will show up here once you create a video." />
          </div>
        )}

        {entries && entries.length > 0 && (
          <div className="mt-8 space-y-3">
            {entries.map((entry) => (
              <Link
                key={entry.id}
                href={`/projects/${entry.project.id}`}
                className="block rounded-sm border border-ink-700 bg-ink-900 p-4 transition hover:border-moon-400"
              >
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-display text-base text-paper">{entry.project.title}</h3>
                  <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs ${statusStyles[entry.status] ?? ""}`}>
                    {entry.status}
                  </span>
                </div>
                <p className="mt-1 text-xs text-paper/50">
                  {entry.project.animeStyle} · {entry.project.duration} · attempt {entry.attemptCount} ·{" "}
                  {new Date(entry.createdAt).toLocaleString()}
                </p>
                {entry.status === "FAILED" && entry.errorMessage && (
                  <p className="mt-2 text-xs text-red-300">{entry.errorMessage}</p>
                )}
              </Link>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
