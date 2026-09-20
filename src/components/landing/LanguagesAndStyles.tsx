import { SUPPORTED_LANGUAGES, ANIME_STYLES } from "@/lib/validation/schemas";

export function LanguagesAndStyles() {
  return (
    <section className="border-b border-ink-700/60 bg-ink-900">
      <div className="mx-auto max-w-6xl px-6 py-24">
        <div className="grid gap-16 md:grid-cols-2">
          <div>
            <h2 className="font-display text-2xl text-paper">Supported languages</h2>
            <p className="mt-2 text-sm text-paper/60">
              Story input, narration, and subtitles all work in each of these.
            </p>
            <ul className="mt-6 flex flex-wrap gap-2">
              {SUPPORTED_LANGUAGES.map((l) => (
                <li key={l} className="rounded-full border border-ink-600 px-3 py-1 text-sm text-paper/80">
                  {l}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h2 className="font-display text-2xl text-paper">Anime styles</h2>
            <p className="mt-2 text-sm text-paper/60">
              Each project picks one style, applied consistently across every scene.
            </p>
            <ul className="mt-6 flex flex-wrap gap-2">
              {ANIME_STYLES.map((s) => (
                <li key={s} className="rounded-full border border-moon-500/40 px-3 py-1 text-sm text-paper/80">
                  {s}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
