"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiRequestError } from "@/lib/api/client";
import { AppNavbar } from "@/components/app/AppNavbar";
import { Field, Input, Select, Textarea } from "@/components/ui/Form";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import {
  SUPPORTED_LANGUAGES,
  ANIME_STYLES,
  DURATIONS,
  ASPECT_RATIOS,
  VOICE_GENDERS,
  VOICE_STYLES,
  MUSIC_MOODS,
} from "@/lib/validation/schemas";

const DURATION_LABELS: Record<string, string> = {
  "30s": "30 seconds",
  "1m": "1 minute",
  "3m": "3 minutes",
  "5m": "5 minutes",
  "10m": "10 minutes",
  custom: "Custom",
};

const ASPECT_LABELS: Record<string, string> = {
  "16:9": "16:9 — YouTube",
  "9:16": "9:16 — Shorts / Reels",
  "1:1": "1:1 — Square",
};

function capitalize(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export default function NewProjectPage() {
  const router = useRouter();
  const { show } = useToast();
  const [story, setStory] = useState("");
  const [language, setLanguage] = useState<string>(SUPPORTED_LANGUAGES[0]);
  const [animeStyle, setAnimeStyle] = useState<string>(ANIME_STYLES[0]);
  const [duration, setDuration] = useState<string>("3m");
  const [aspectRatio, setAspectRatio] = useState<string>("16:9");
  const [voiceGender, setVoiceGender] = useState<string>(VOICE_GENDERS[0]);
  const [voiceStyle, setVoiceStyle] = useState<string>(VOICE_STYLES[0]);
  const [subtitlesOn, setSubtitlesOn] = useState(true);
  const [musicMood, setMusicMood] = useState<string>("cinematic");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const project = await api.post<{ id: string }>("/api/projects", {
        story,
        language,
        animeStyle,
        duration,
        aspectRatio,
        voiceGender,
        voiceStyle,
        subtitlesOn,
        musicMood,
      });
      show("Project created successfully! 🎬", "success");
      await api.post(`/api/projects/${project.id}/generate`);
      show("Video generation started! 🎬", "success");
      router.push(`/projects/${project.id}`);
    } catch (err) {
      const msg = err instanceof ApiRequestError ? err.message : "Unable to create project. Please try again.";
      setError(msg);
      show(msg, "error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-ink-950">
      <AppNavbar />
      <div className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="font-display text-3xl text-paper">Generate a video</h1>
        <p className="mt-2 text-sm text-paper/60">
          Write your story, choose how it should look and sound, then generate.
        </p>

        <form onSubmit={onSubmit} className="mt-8 space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Language" htmlFor="language">
              <Select id="language" value={language} onChange={(e) => setLanguage(e.target.value)}>
                {SUPPORTED_LANGUAGES.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Anime style" htmlFor="animeStyle">
              <Select id="animeStyle" value={animeStyle} onChange={(e) => setAnimeStyle(e.target.value)}>
                {ANIME_STYLES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Duration" htmlFor="duration">
              <Select id="duration" value={duration} onChange={(e) => setDuration(e.target.value)}>
                {DURATIONS.map((d) => (
                  <option key={d} value={d}>
                    {DURATION_LABELS[d]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Format" htmlFor="aspectRatio">
              <Select id="aspectRatio" value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)}>
                {ASPECT_RATIOS.map((a) => (
                  <option key={a} value={a}>
                    {ASPECT_LABELS[a]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Field label="Your story" htmlFor="story" hint={`${story.length} characters`}>
            <Textarea
              id="story"
              required
              rows={10}
              placeholder="A man returning home at midnight sees a mysterious woman sitting outside his house..."
              value={story}
              onChange={(e) => setStory(e.target.value)}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Voice" htmlFor="voiceGender">
              <Select id="voiceGender" value={voiceGender} onChange={(e) => setVoiceGender(e.target.value)}>
                {VOICE_GENDERS.map((v) => (
                  <option key={v} value={v}>
                    {capitalize(v)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Voice style" htmlFor="voiceStyle">
              <Select id="voiceStyle" value={voiceStyle} onChange={(e) => setVoiceStyle(e.target.value)}>
                {VOICE_STYLES.map((v) => (
                  <option key={v} value={v}>
                    {v.replace("_", " ")}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Music" htmlFor="musicMood">
              <Select id="musicMood" value={musicMood} onChange={(e) => setMusicMood(e.target.value)}>
                {MUSIC_MOODS.map((m) => (
                  <option key={m} value={m}>
                    {capitalize(m)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Subtitles" htmlFor="subtitlesOn">
              <label className="flex h-[42px] items-center gap-2 text-sm text-paper/80">
                <input
                  id="subtitlesOn"
                  type="checkbox"
                  checked={subtitlesOn}
                  onChange={(e) => setSubtitlesOn(e.target.checked)}
                  className="h-4 w-4 accent-lantern-500"
                />
                Burn in subtitles
              </label>
            </Field>
          </div>

          {error && <p className="text-sm text-red-300">{error}</p>}

          <Button type="submit" disabled={loading || story.trim().length < 20} className="w-full">
            {loading ? "Starting generation..." : "Generate video"}
          </Button>
        </form>
      </div>
    </main>
  );
}
