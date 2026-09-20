import Link from "next/link";

export function FinalCta() {
  return (
    <section className="relative overflow-hidden border-b border-ink-700/60">
      <div className="absolute inset-0 bg-lantern-glow" aria-hidden />
      <div className="relative mx-auto max-w-3xl px-6 py-24 text-center">
        <h2 className="font-display text-4xl text-paper">Your story is waiting to be told.</h2>
        <p className="mt-4 text-paper/70">
          Start with a paragraph. See it come back as a scene.
        </p>
        <Link
          href="/register"
          className="mt-8 inline-block rounded-full bg-lantern-500 px-8 py-3 text-sm font-semibold text-ink-950 transition hover:bg-lantern-400"
        >
          Create your video
        </Link>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="bg-ink-950">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-10 text-sm text-paper/50 md:flex-row">
        <span>© {new Date().getFullYear()} Anime Video Generator.</span>
        <div className="flex gap-6">
          <a href="/terms" className="hover:text-paper">
            Terms
          </a>
          <a href="/privacy" className="hover:text-paper">
            Privacy
          </a>
        </div>
      </div>
    </footer>
  );
}
