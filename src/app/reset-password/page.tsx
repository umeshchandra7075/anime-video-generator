"use client";

import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { api, ApiRequestError } from "@/lib/api/client";
import { Field, Input } from "@/components/ui/Form";
import { Button } from "@/components/ui/Button";
import { AuthShell } from "@/components/auth/AuthShell";
import { useToast } from "@/components/ui/Toast";

// See verify-email/page.tsx for why useSearchParams() requires this
// Suspense wrapper - without it, `next build` fails to statically generate
// this route at all.
export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<AuthShell title="Reset your password"><p className="text-sm text-paper/60">Loading...</p></AuthShell>}>
      <ResetPasswordContent />
    </Suspense>
  );
}

function ResetPasswordContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { show } = useToast();
  const token = searchParams.get("token") ?? "";
  const [form, setForm] = useState({ password: "", confirmPassword: "" });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (form.password !== form.confirmPassword) {
      const msg = "Passwords do not match.";
      setError(msg);
      show(msg, "error");
      return;
    }

    setLoading(true);
    try {
      await api.post("/api/auth/reset-password", { token, ...form });
      show("Password reset successfully! 🔐", "success");
      router.push("/login");
    } catch (err) {
      const msg = err instanceof ApiRequestError ? err.message : "This password reset link is invalid or has expired.";
      setError(msg);
      show(msg, "error");
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <AuthShell title="Invalid link">
        <p className="text-sm text-red-300">This password reset link is invalid.</p>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Set a new password">
      <form onSubmit={onSubmit} className="space-y-5">
        <Field label="New password" htmlFor="password" hint="At least 10 characters, with upper, lower, and a number.">
          <Input
            id="password"
            type="password"
            required
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
        </Field>
        <Field label="Confirm new password" htmlFor="confirmPassword">
          <Input
            id="confirmPassword"
            type="password"
            required
            value={form.confirmPassword}
            onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })}
          />
        </Field>
        {error && <p className="text-sm text-red-300">{error}</p>}
        <Button type="submit" disabled={loading} className="w-full">
          {loading ? "Resetting password..." : "Reset password"}
        </Button>
      </form>
    </AuthShell>
  );
}
