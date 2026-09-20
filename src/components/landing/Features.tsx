const features = [
  {
    title: "Character consistency",
    body: "Every character keeps the same design, outfit, and colors across every scene they appear in — no redesigns between panels.",
  },
  {
    title: "Full storyboard control",
    body: "Review every scene before it's animated. Edit a description, regenerate an image, or reorder scenes without starting over.",
  },
  {
    title: "14 languages",
    body: "Write and narrate in Telugu, Hindi, Tamil, Japanese, Spanish, and more, with subtitles in your language or the original.",
  },
  {
    title: "Real progress, not a spinner",
    body: "Watch each stage — story analysis, animation, voice, music, rendering — complete in order, with retries if a scene fails.",
  },
  {
    title: "Any aspect ratio",
    body: "Render for YouTube (16:9), Shorts and Reels (9:16), or square (1:1) from the same story.",
  },
  {
    title: "Your projects, only yours",
    body: "Every project, scene, and rendered file is private to your account and served through short-lived signed links.",
  },
];

export function Features() {
  return (
    <section id="features" className="border-b border-ink-700/60">
      <div className="mx-auto max-w-6xl px-6 py-24">
        <h2 className="font-display text-3xl text-paper md:text-4xl">Built for finishing, not just starting</h2>
        <div className="mt-12 grid gap-8 md:grid-cols-3">
          {features.map((f) => (
            <div key={f.title} className="border-t border-lantern-500/40 pt-5">
              <h3 className="font-semibold text-paper">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-paper/60">{f.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
