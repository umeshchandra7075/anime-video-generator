"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, ApiRequestError } from "@/lib/api/client";
import { AuthShell } from "@/components/auth/AuthShell";
import { useToast } from "@/components/ui/Toast";

// useSearchParams() opts a component into client-side rendering for that
// subtree, which Next's App Router requires to be wrapped in <Suspense> -
// without it, static generation for this route fails outright (this broke
// `next build` until this fix). The default export below stays a thin
// Suspense wrapper; all the real logic lives in the inner component.
export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<AuthShell title="Verifying"><p className="text-sm text-paper/70">Verifying your email...</p></AuthShell>}>
      <VerifyEmailContent />
    </Suspense>
  );
}

function VerifyEmailContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const { show } = useToast();
  const [status, setStatus] = useState<"pending" | "success" | "error">("pending");
  const [message, setMessage] = useState("Verifying your email...");

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setMessage("This verification link is invalid.");
      return;
    }
    api
      .post<{ message: string }>("/api/auth/verify-email", { token })
      .then(() => {
        setStatus("success");
        setMessage("You can now log in to your account.");
        show("Email verified successfully! ✅", "success");
      })
      .catch((err) => {
        setStatus("error");
        const message =
          err instanceof ApiRequestError
            ? err.message
            : "This verification link is invalid.";
        setMessage(message);
        show(message, "error");
      });
    // Only re-run if the token itself changes - `show` is stable for the
    // lifetime of the ToastProvider and including it would re-fire this
    // effect (and re-verify) on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <AuthShell title={status === "success" ? "Email verified successfully! ✅" : status === "error" ? "Verification failed" : "Verifying"}>
      <p className={`text-sm ${status === "error" ? "text-red-300" : "text-paper/70"}`}>{message}</p>
      {status !== "pending" && (
        <Link href="/login" className="mt-6 inline-block text-sm font-semibold text-moon-300 hover:text-moon-200">
          Go to log in
        </Link>
      )}
    </AuthShell>
  );
}
