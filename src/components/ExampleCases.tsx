import { EXAMPLE_CASES } from "@/lib/examples";

export function ExampleCases() {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-lg font-semibold text-amber-300">
        เคสตัวอย่างในอดีต{" "}
        <span className="text-sm font-normal text-zinc-500">
          (Historical examples — not live signals)
        </span>
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {EXAMPLE_CASES.map((c) => (
          <article
            key={c.id}
            className="rounded-xl border border-zinc-800 bg-zinc-900/80 p-4 shadow-lg shadow-black/20"
          >
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <h3 className="text-base font-bold text-emerald-400">{c.titleTh}</h3>
              <span className="text-[10px] uppercase tracking-wide text-zinc-500">
                อดีต
              </span>
            </div>
            <p className="mb-2 font-mono text-xs text-zinc-400">{c.symbolHint}</p>
            <p className="mb-3 text-xs leading-relaxed text-zinc-300">{c.summaryTh}</p>
            <div className="flex flex-wrap gap-1">
              {c.tags.map((t) => (
                <span
                  key={t}
                  className="rounded-md bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400"
                >
                  {t}
                </span>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
