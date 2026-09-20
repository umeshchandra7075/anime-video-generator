"use client";

import { useEffect, useState } from "react";
import { api, ApiRequestError } from "@/lib/api/client";
import { AppNavbar } from "@/components/app/AppNavbar";
import { Field, Input } from "@/components/ui/Form";
import { Button } from "@/components/ui/Button";
import { LoadingSkeleton, ErrorState } from "@/components/ui/States";
import { useToast } from "@/components/ui/Toast";

interface Profile {
  id: string;
  name: string;
  email: string;
  role: string;
  credits: number;
  emailVerifiedAt: string | null;
  createdAt: string;
}

export default function ProfilePage() {
  const { show } = useToast();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function load() {
    api
      .get<Profile>("/api/user")
      .then((p) => {
        setProfile(p);
        setName(p.name);
      })
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load your profile."));
  }

  useEffect(load, []);

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const updated = await api.patch<Profile>("/api/user", { name });
      setProfile((p) => (p ? { ...p, name: updated.name } : p));
      show("Profile updated.", "success");
    } catch (err) {
      show(err instanceof ApiRequestError ? err.message : "Could not update your profile.", "error");
    } finally {
      setSaving(false);
    }
  }

  if (error) {
    return (
      <main className="min-h-screen bg-ink-950">
        <AppNavbar />
        <div className="mx-auto max-w-2xl px-6 py-12">
          <ErrorState message={error} onRetry={load} />
        </div>
      </main>
    );
  }

  if (!profile) {
    return (
      <main className="min-h-screen bg-ink-950">
        <AppNavbar />
        <div className="mx-auto max-w-2xl space-y-4 px-6 py-12">
          <LoadingSkeleton className="h-10 w-1/2" />
          <LoadingSkeleton className="h-48 w-full" />
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-ink-950">
      <AppNavbar />
      <div className="mx-auto max-w-2xl px-6 py-12">
        <h1 className="font-display text-3xl text-paper">Profile</h1>

        <div className="mt-8 rounded-sm border border-ink-700 bg-ink-900 p-6">
          <form onSubmit={saveName} className="space-y-5">
            <Field label="Full name" htmlFor="name">
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} />
            </Field>
            <Field label="Email" htmlFor="email" hint={profile.emailVerifiedAt ? "Verified" : "Not verified"}>
              <Input id="email" value={profile.email} disabled className="opacity-60" />
            </Field>
            <Button type="submit" disabled={saving || name === profile.name}>
              {saving ? "Saving..." : "Save changes"}
            </Button>
          </form>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
          <InfoCard label="Role" value={profile.role} />
          <InfoCard label="Credits" value={String(profile.credits)} />
          <InfoCard label="Member since" value={new Date(profile.createdAt).toLocaleDateString()} />
        </div>
      </div>
    </main>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-sm border border-ink-700 bg-ink-900 p-4">
      <p className="text-xs text-paper/50">{label}</p>
      <p className="mt-1 text-sm text-paper">{value}</p>
    </div>
  );
}
