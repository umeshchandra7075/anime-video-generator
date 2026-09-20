"use client";

import { useState } from "react";
import Link from "next/link";
import { api, ApiRequestError } from "@/lib/api/client";
import { Field, Input } from "@/components/ui/Form";
import { Button } from "@/components/ui/Button";
import { AuthShell } from "@/components/auth/AuthShell";
import { useToast } from "@/components/ui/Toast";

export default function ForgotPasswordPage() {
  const { show } = useToast();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [devResetUrl, setDevResetUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const data = await api.post<{ message: string; devResetUrl?: string }>("/api/auth/forgot-password", { email });
      setDevResetUrl(data.devResetUrl ?? null);
      setSent(true);
      show("If an account exists for this email, reset instructions have been sent.", "success");
    } catch (err) {
      const msg = err instanceof ApiRequestError ? err.message : "Unable to connect to the server. Please try again.";
      setError(msg);
      show(msg, "error");
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <AuthShell title="Check your email">
        <p className="text-sm text-paper/70">
          If an account exists for {email}, a reset link is on its way.
        </p>
        {devResetUrl && (
          <div className="mt-4 rounded-sm border border-lantern-500/40 bg-lantern-500/5 p-3">
            <p className="text-xs text-lantern-400">Development mode - no email service configured:</p>
            <a href={devResetUrl} className="mt-1 block break-all text-xs text-moon-300 hover:text-moon-200">
              {devResetUrl}
            </a>
          </div>
        )}
        <Link href="/login" className="mt-6 inline-block text-sm font-semibold text-moon-300 hover:text-moon-200">
          Back to log in
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Reset your password">
      <form onSubmit={onSubmit} className="space-y-5">
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        {error && <p className="text-sm text-red-300">{error}</p>}
        <Button type="submit" disabled={loading} className="w-full">
          {loading ? "Sending..." : "Send reset link"}
        </Button>
      </form>
    </AuthShell>
  );
}
