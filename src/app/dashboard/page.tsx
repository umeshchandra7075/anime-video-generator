"use client";

import { useEffect, useState } from "react";
import { api, ApiRequestError } from "@/lib/api/client";
import { AppNavbar } from "@/components/app/AppNavbar";
import { StatCard, ProjectCard, ProjectSummary } from "@/components/app/Cards";
import { LoadingSkeleton, ErrorState, EmptyState } from "@/components/ui/States";
import { Button } from "@/components/ui/Button";
import Link from "next/link";

interface DashboardData {
  totals: { total: number; completed: number; processing: number; failed: number; remainingCredits: number };
  recentVideos: ProjectSummary[];
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    setError(null);
    api
      .get<DashboardData>("/api/dashboard")
      .then(setData)
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Failed to load dashboard."))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  return (
    <main className="min-h-screen bg-ink-950">
      <AppNavbar />
      <div className="mx-auto max-w-6xl px-6 py-12">
        <h1 className="font-display text-3xl text-paper">Dashboard</h1>

        {loading && (
          <div className="mt-8 grid grid-cols-2 gap-4 md:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <LoadingSkeleton key={i} className="h-24" />
            ))}
          </div>
        )}

        {error && <div className="mt-8">
          <ErrorState message={error} onRetry={load} />
        </div>}

        {data && (
          <>
            <div className="mt-8 grid grid-cols-2 gap-4 md:grid-cols-5">
              <StatCard label="Total videos" value={data.totals.total} />
              <StatCard label="Completed" value={data.totals.completed} />
              <StatCard label="Processing" value={data.totals.processing} />
              <StatCard label="Failed" value={data.totals.failed} />
              <StatCard label="Credits remaining" value={data.totals.remainingCredits} />
            </div>

            <div className="mt-12 flex items-center justify-between">
              <h2 className="font-display text-xl text-paper">Recent videos</h2>
              <Link href="/projects/new">
                <Button>Create new video</Button>
              </Link>
            </div>

            <div className="mt-6">
              {data.recentVideos.length === 0 ? (
                <EmptyState
                  title="No videos yet"
                  body="Write your first story and see it come back as an anime scene."
                  action={
                    <Link href="/projects/new">
                      <Button>Create your first video</Button>
                    </Link>
                  }
                />
              ) : (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {data.recentVideos.map((p) => (
                    <ProjectCard key={p.id} project={p} />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
