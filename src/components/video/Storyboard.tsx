"use client";

import { useState } from "react";
import { api, ApiRequestError } from "@/lib/api/client";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";

export interface SceneSummary {
  id: string;
  sceneNumber: number;
  description: string | null;
  status: string;
  errorMessage: string | null;
  estimatedSeconds: number | null;
}

export function Storyboard({ scenes, onChanged }: { scenes: SceneSummary[]; onChanged: () => void }) {
  if (scenes.length === 0) return null;

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {scenes
        .sort((a, b) => a.sceneNumber - b.sceneNumber)
        .map((scene) => (
          <SceneCard key={scene.id} scene={scene} onChanged={onChanged} />
        ))}
    </div>
  );
}

function SceneCard({ scene, onChanged }: { scene: SceneSummary; onChanged: () => void }) {
  const { show } = useToast();
  const [busy, setBusy] = useState<"retry" | "regenerate" | null>(null);

  async function retry() {
    setBusy("retry");
    try {
      await api.post(`/api/scenes/${scene.id}/retry`);
      show("Scene retried.", "success");
      onChanged();
    } catch (err) {
      show(err instanceof ApiRequestError ? err.message : "Retry failed.", "error");
    } finally {
      setBusy(null);
    }
  }

  async function regenerate() {
    setBusy("regenerate");
    try {
      await api.post(`/api/scenes/${scene.id}/regenerate`);
      show("Scene regenerated.", "success");
      onChanged();
    } catch (err) {
      show(err instanceof ApiRequestError ? err.message : "Regeneration failed.", "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-sm border border-ink-700 bg-ink-900 p-4">
      <div className="flex items-center justify-between">
        <h4 className="font-display text-sm italic text-lantern-400">Scene {scene.sceneNumber}</h4>
        <span
          className={`text-xs ${
            scene.status === "FAILED"
              ? "text-red-300"
              : scene.status === "COMPLETED"
                ? "text-moon-400"
                : "text-paper/50"
          }`}
        >
          {scene.status}
        </span>
      </div>
      <p className="mt-2 line-clamp-3 text-sm text-paper/70">{scene.description}</p>
      {scene.status === "FAILED" && (
        <>
          <p className="mt-2 text-xs text-red-300">{scene.errorMessage}</p>
          <div className="mt-3 flex gap-2">
            <Button variant="secondary" className="!px-3 !py-1.5 text-xs" onClick={retry} disabled={busy !== null}>
              {busy === "retry" ? "Retrying..." : "Retry"}
            </Button>
            <Button variant="secondary" className="!px-3 !py-1.5 text-xs" onClick={regenerate} disabled={busy !== null}>
              {busy === "regenerate" ? "Regenerating..." : "Regenerate"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
