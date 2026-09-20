"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api/client";
import { useToast } from "@/components/ui/Toast";

export function AppNavbar() {
  const router = useRouter();
  const { show } = useToast();

  async function logout() {
    await api.post("/api/auth/logout").catch(() => {});
    show("Logged out successfully.", "success");
    router.push("/login");
  }

  return (
    <header className="border-b border-ink-700/60 bg-ink-950">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link href="/dashboard" className="font-display text-lg italic text-paper">
          Anime Video Generator
        </Link>
        <nav className="flex items-center gap-5 text-sm">
          <Link href="/dashboard" className="text-paper/70 hover:text-paper">
            Dashboard
          </Link>
          <Link href="/history" className="text-paper/70 hover:text-paper">
            History
          </Link>
          <Link href="/assets" className="text-paper/70 hover:text-paper">
            Assets
          </Link>
          <Link href="/ai-chat" className="text-paper/70 hover:text-paper">
            AI Chat
          </Link>
          <Link href="/settings" className="text-paper/70 hover:text-paper">
            Settings
          </Link>
          <Link href="/profile" className="text-paper/70 hover:text-paper">
            Profile
          </Link>
          <Link
            href="/projects/new"
            className="rounded-full bg-lantern-500 px-4 py-2 font-semibold text-ink-950 hover:bg-lantern-400"
          >
            Create video
          </Link>
          <button onClick={logout} className="text-paper/50 hover:text-paper">
            Log out
          </button>
        </nav>
      </div>
    </header>
  );
}
