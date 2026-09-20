const tiers = [
  { name: "Starter", credits: "50 credits / month", detail: "Enough for a handful of short scenes while you try the workflow." },
  { name: "Creator", credits: "300 credits / month", detail: "For a steady cadence of 1–5 minute videos." },
  { name: "Studio", credits: "1,200 credits / month", detail: "For longer projects and higher volume." },
];

export function Pricing() {
  return (
    <section id="pricing" className="border-b border-ink-700/60">
      <div className="mx-auto max-w-6xl px-6 py-24">
        <h2 className="font-display text-3xl text-paper md:text-4xl">Pricing</h2>
        <p className="mt-2 max-w-lg text-sm text-paper/60">
          Generation is metered by credits, which scale with video length. Final
          pricing is being finalized — this page will update before checkout goes live.
        </p>
        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {tiers.map((t) => (
            <div key={t.name} className="rounded-sm border border-ink-600 p-6">
              <h3 className="font-display text-xl italic text-lantern-400">{t.name}</h3>
              <p className="mt-3 text-sm font-medium text-paper">{t.credits}</p>
              <p className="mt-2 text-sm text-paper/60">{t.detail}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
