const faqs = [
  {
    q: "Does this create fully original animation, or reuse existing footage?",
    a: "Every frame is generated from your story text through AI image and video models — nothing is pulled from existing anime, shows, or footage.",
  },
  {
    q: "Is this affiliated with any anime studio?",
    a: "No. \"Anime style\" here refers to a visual aesthetic, not any real production studio, franchise, or IP.",
  },
  {
    q: "What happens if a scene fails to generate?",
    a: "The rest of the project keeps going. You can retry, regenerate, or skip the failed scene from the storyboard.",
  },
  {
    q: "Can I edit the story after generation starts?",
    a: "Once a project is generating, its story is locked; duplicate the project to make changes and generate again.",
  },
  {
    q: "Where is my video stored?",
    a: "In private object storage, never publicly accessible. You and only you get signed, time-limited links to preview or download it.",
  },
];

export function Faq() {
  return (
    <section id="faq" className="border-b border-ink-700/60 bg-ink-900">
      <div className="mx-auto max-w-3xl px-6 py-24">
        <h2 className="font-display text-3xl text-paper md:text-4xl">Frequently asked</h2>
        <dl className="mt-10 divide-y divide-ink-700/60">
          {faqs.map((f) => (
            <div key={f.q} className="py-6">
              <dt className="font-semibold text-paper">{f.q}</dt>
              <dd className="mt-2 text-sm leading-relaxed text-paper/60">{f.a}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
