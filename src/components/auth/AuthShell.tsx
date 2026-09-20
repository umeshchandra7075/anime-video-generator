import Link from "next/link";

export function AuthShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-ink-950 px-6">
      <div className="w-full max-w-sm">
        <Link href="/" className="font-display text-lg italic text-paper/70">
          Anime Video Generator
        </Link>
        <h1 className="mt-6 font-display text-3xl text-paper">{title}</h1>
        <div className="mt-8 rounded-sm border border-ink-700 bg-ink-900 p-6">{children}</div>
      </div>
    </main>
  );
}
