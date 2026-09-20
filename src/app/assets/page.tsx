"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, ApiRequestError } from "@/lib/api/client";
import { AppNavbar } from "@/components/app/AppNavbar";
import { LoadingSkeleton, ErrorState, EmptyState } from "@/components/ui/States";

interface AssetEntry {
  type: "video" | "character_image";
  projectId: string;
  projectTitle: string;
  name: string;
  url: string;
  createdAt: string;
}

export default function AssetsPage() {
  const [assets, setAssets] = useState<AssetEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setError(null);
    api
      .get<{ items: AssetEntry[] }>("/api/assets")
      .then((data) => setAssets(data.items))
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load your assets."));
  }

  useEffect(load, []);

  return (
    <main className="min-h-screen bg-ink-950">
      <AppNavbar />
      <div className="mx-auto max-w-6xl px-6 py-12">
        <h1 className="font-display text-3xl text-paper">Assets</h1>
        <p className="mt-2 text-sm text-paper/60">Final videos and character art generated across your projects.</p>

        {error && (
          <div className="mt-8">
            <ErrorState message={error} onRetry={load} />
          </div>
        )}

        {!error && !assets && (
          <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <LoadingSkeleton key={i} className="aspect-square w-full" />
            ))}
          </div>
        )}

        {assets && assets.length === 0 && (
          <div className="mt-8">
            <EmptyState title="No assets yet" body="Generated videos and character art will appear here once a project finishes." />
          </div>
        )}

        {assets && assets.length > 0 && (
          <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {assets.map((asset, i) => (
              <Link
                key={i}
                href={`/projects/${asset.projectId}`}
                className="group block overflow-hidden rounded-sm border border-ink-700 bg-ink-900 transition hover:border-moon-400"
              >
                <div className="flex aspect-square items-center justify-center bg-ink-800">
                  {asset.type === "video" ? (
                    // eslint-disable-next-line @next/next/no-img-element -- signed URL, not a static asset next/image can optimize
                    <video src={asset.url} className="h-full w-full object-cover" muted />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element -- signed URL, not a static asset next/image can optimize
                    <img src={asset.url} alt={asset.name} className="h-full w-full object-cover" />
                  )}
                </div>
                <div className="p-3">
                  <p className="truncate text-sm text-paper">{asset.name}</p>
                  <p className="truncate text-xs text-paper/50">{asset.projectTitle}</p>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
