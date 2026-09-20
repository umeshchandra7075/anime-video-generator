const steps = [
  {
    title: "Write your story",
    body: "Paste a few paragraphs or a full script. Midnight encounters, slow-burn romances, sprawling fantasy arcs — the generator works from whatever you give it.",
  },
  {
    title: "The story gets broken down",
    body: "An AI reads your story and pulls out characters, locations, camera direction, and dialogue — the same pre-production work a studio would do by hand.",
  },
  {
    title: "Scenes are illustrated and animated",
    body: "Each scene is rendered in your chosen anime style, with the same character designs carried through from the first frame to the last.",
  },
  {
    title: "Voice, music, and subtitles are added",
    body: "Narration and dialogue are voiced in your chosen language, scored with mood-matched music, and captioned automatically.",
  },
  {
    title: "Watch, download, or share",
    body: "The finished cut renders as an MP4 you can preview in-browser, download, or share a link to.",
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="border-b border-ink-700/60 bg-ink-900">
      <div className="mx-auto max-w-6xl px-6 py-24">
        <h2 className="font-display text-3xl text-paper md:text-4xl">How it works</h2>
        <ol className="mt-12 grid gap-px overflow-hidden rounded-sm border border-ink-700/60 bg-ink-700/60 md:grid-cols-5">
          {steps.map((step, i) => (
            <li key={step.title} className="flex flex-col gap-3 bg-ink-900 p-6">
              <span className="font-display text-2xl italic text-lantern-400">{i + 1}</span>
              <h3 className="font-semibold text-paper">{step.title}</h3>
              <p className="text-sm leading-relaxed text-paper/60">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
