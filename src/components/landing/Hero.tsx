import Link from "next/link";

export function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-ink-700/60">
      <div className="absolute inset-0 bg-lantern-glow" aria-hidden />
      <div className="absolute inset-0 bg-moon-glow" aria-hidden />
      <div className="relative mx-auto grid max-w-6xl gap-16 px-6 py-24 md:grid-cols-[1.1fr_0.9fr] md:py-32">
        <div>
          <p className="font-display text-sm italic text-moon-400">A story, told frame by frame.</p>
          <h1 className="mt-4 font-display text-5xl leading-[1.05] text-paper md:text-6xl">
            Turn your stories
            <br />
            into anime.
          </h1>
          <p className="mt-6 max-w-md text-lg text-paper/70">
            Write what happens. The generator breaks it into scenes, keeps your
            characters consistent from panel to panel, and hands you back a
            finished, narrated video.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-4">
            <Link
              href="/register"
              className="rounded-full bg-lantern-500 px-6 py-3 text-sm font-semibold text-ink-950 transition hover:bg-lantern-400"
            >
              Create your video
            </Link>
            <a
              href="#how-it-works"
              className="rounded-full border border-ink-600 px-6 py-3 text-sm font-semibold text-paper/80 transition hover:border-moon-400 hover:text-paper"
            >
              See how it works
            </a>
          </div>
        </div>

        <div className="relative">
          <StoryboardPanels />
        </div>
      </div>
    </section>
  );
}

function StoryboardPanels() {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Panel className="col-span-2 aspect-[16/7]" gradient="from-ink-800 via-ink-700 to-lantern-600/40" label="Scene 01 — Midnight street" />
      <Panel className="aspect-square" gradient="from-ink-800 to-moon-500/30" label="Scene 02" />
      <Panel className="aspect-square" gradient="from-lantern-600/40 to-ink-800" label="Scene 03" />
    </div>
  );
}

function Panel({
  className = "",
  gradient,
  label,
}: {
  className?: string;
  gradient: string;
  label: string;
}) {
  return (
    <div
      className={`relative rounded-sm border border-ink-600/80 bg-gradient-to-br ${gradient} p-3 ${className}`}
    >
      <span className="absolute bottom-3 left-3 font-display text-xs italic text-paper/70">{label}</span>
    </div>
  );
}
