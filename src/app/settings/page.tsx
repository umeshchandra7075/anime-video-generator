"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiRequestError } from "@/lib/api/client";
import { AppNavbar } from "@/components/app/AppNavbar";
import { Field, Input } from "@/components/ui/Form";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";

export default function SettingsPage() {
  const router = useRouter();
  const { show } = useToast();

  const [passwordForm, setPasswordForm] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [changingPassword, setChangingPassword] = useState(false);
  const [showDeleteForm, setShowDeleteForm] = useState(false);

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setChangingPassword(true);
    try {
      await api.post("/api/user/change-password", passwordForm);
      show("Password updated. Please log in again.", "success");
      router.push("/login");
    } catch (err) {
      show(err instanceof ApiRequestError ? err.message : "Could not update password.", "error");
    } finally {
      setChangingPassword(false);
    }
  }

  return (
    <main className="min-h-screen bg-ink-950">
      <AppNavbar />
      <div className="mx-auto max-w-2xl space-y-8 px-6 py-12">
        <h1 className="font-display text-3xl text-paper">Settings</h1>

        <section className="rounded-sm border border-ink-700 bg-ink-900 p-6">
          <h2 className="font-display text-lg text-paper">Change password</h2>
          <form onSubmit={changePassword} className="mt-5 space-y-5">
            <Field label="Current password" htmlFor="currentPassword">
              <Input
                id="currentPassword"
                type="password"
                required
                value={passwordForm.currentPassword}
                onChange={(e) => setPasswordForm({ ...passwordForm, currentPassword: e.target.value })}
              />
            </Field>
            <Field label="New password" htmlFor="newPassword" hint="At least 10 characters, with upper, lower, and a number.">
              <Input
                id="newPassword"
                type="password"
                required
                value={passwordForm.newPassword}
                onChange={(e) => setPasswordForm({ ...passwordForm, newPassword: e.target.value })}
              />
            </Field>
            <Field label="Confirm new password" htmlFor="confirmPassword">
              <Input
                id="confirmPassword"
                type="password"
                required
                value={passwordForm.confirmPassword}
                onChange={(e) => setPasswordForm({ ...passwordForm, confirmPassword: e.target.value })}
              />
            </Field>
            <Button type="submit" disabled={changingPassword}>
              {changingPassword ? "Saving..." : "Update password"}
            </Button>
          </form>
        </section>

        <section className="rounded-sm border border-red-500/30 bg-red-500/5 p-6">
          <h2 className="font-display text-lg text-red-300">Danger zone</h2>
          <p className="mt-2 text-sm text-paper/60">
            Permanently deletes your account, all projects, and all generated videos. This cannot be undone.
          </p>
          {!showDeleteForm ? (
            <Button variant="danger" className="mt-4" onClick={() => setShowDeleteForm(true)}>
              Delete account
            </Button>
          ) : (
            <DeleteAccountForm onCancel={() => setShowDeleteForm(false)} />
          )}
        </section>
      </div>
    </main>
  );
}

function DeleteAccountForm({ onCancel }: { onCancel: () => void }) {
  const router = useRouter();
  const { show } = useToast();
  const [password, setPassword] = useState("");
  const [deleting, setDeleting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setDeleting(true);
    try {
      await api.delete("/api/user", { password });
      show("Account deleted.", "success");
      router.push("/");
    } catch (err) {
      show(err instanceof ApiRequestError ? err.message : "Could not delete account.", "error");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-4 space-y-3">
      <Field label="Confirm your password" htmlFor="deletePassword">
        <Input id="deletePassword" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" variant="danger" disabled={deleting}>
          {deleting ? "Deleting..." : "Permanently delete my account"}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
