"use client";

import { useState } from "react";
import Link from "next/link";
import { api, ApiRequestError } from "@/lib/api/client";
import { Field, Input } from "@/components/ui/Form";
import { Button } from "@/components/ui/Button";
import { AuthShell } from "@/components/auth/AuthShell";
import { useToast } from "@/components/ui/Toast";

export default function RegisterPage() {
  const { show } = useToast();
  const [form, setForm] = useState({ name: "", email: "", password: "", confirmPassword: "" });
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [devVerificationUrl, setDevVerificationUrl] = useState<string | null>(null);
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
      const data = await api.post<{ message: string; devVerificationUrl?: string }>("/api/auth/register", form);
      setDevVerificationUrl(data.devVerificationUrl ?? null);
      setSubmitted(true);
      show("Registration successful! 🎉", "success");
    } catch (err) {
      const msg = err instanceof ApiRequestError ? err.message : "Unable to connect to the server. Please try again.";
      setError(msg);
      show(msg, "error");
    } finally {
      setLoading(false);
    }
  }

  if (submitted) {
    return (
      <AuthShell title="Registration successful! 🎉">
        <p className="text-sm text-paper/70">
          Your account has been created. Please verify your email to continue - we&apos;ve sent a link to{" "}
          <span className="text-paper">{form.email}</span>.
        </p>
        {devVerificationUrl && (
          <div className="mt-4 rounded-sm border border-lantern-500/40 bg-lantern-500/5 p-3">
            <p className="text-xs text-lantern-400">Development mode - no email service configured:</p>
            <a href={devVerificationUrl} className="mt-1 block break-all text-xs text-moon-300 hover:text-moon-200">
              {devVerificationUrl}
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
    <AuthShell title="Create your account">
      <form onSubmit={onSubmit} className="space-y-5">
        <Field label="Name" htmlFor="name">
          <Input
            id="name"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </Field>
        <Field label="Email" htmlFor="email">
          <Input
            id="email"
            type="email"
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </Field>
        <Field label="Password" htmlFor="password" hint="At least 10 characters, with upper, lower, and a number.">
          <Input
            id="password"
            type="password"
            required
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
        </Field>
        <Field label="Confirm password" htmlFor="confirmPassword">
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
          {loading ? "Creating account..." : "Create account"}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-paper/60">
        Already have an account?{" "}
        <Link href="/login" className="text-moon-300 hover:text-moon-200">
          Log in
        </Link>
      </p>
    </AuthShell>
  );
}
