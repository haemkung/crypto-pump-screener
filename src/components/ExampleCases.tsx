"use client";

import { useEffect, useState } from "react";
import { EXAMPLE_CASES } from "@/lib/examples";
import type { LearnedCase } from "@/lib/types";
import { apiUrl } from "@/lib/apiBase";

interface LearnedCasesResponse {
  cases: LearnedCase[];
  count: number;
  disclaimerTh?: string;
}

export function ExampleCases() {
  const [learned, setLearned] = useState<LearnedCase[]>([]);
  const [learnedErr, setLearnedErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(apiUrl("/api/learned-cases"), { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as LearnedCasesResponse;
        if (!cancelled) setLearned(Array.isArray(data.cases) ? data.cases : []);
      } catch (e) {
        if (!cancelled) setLearnedErr(String(e));
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const showLearned = learned.filter(
    (c) => c.outcome === "win" || c.outcome === "loss"
  );

  return (
    <section className="mb-8 space-y-8">
      <div>
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
      </div>

      <div>
        <h2 className="mb-1 text-lg font-semibold text-sky-300">
          เคสที่ระบบเรียนรู้{" "}
          <span className="text-sm font-normal text-zinc-500">
            (Learned from NOW alert outcomes)
          </span>
        </h2>
        <p className="mb-3 text-xs text-zinc-500">
          จากผลจริงหลังแจ้งเตือน เข้าตอนนี้ (15m / 60m) — heuristic ไม่การันตี
          {learnedErr && (
            <span className="ml-2 text-rose-400">โหลดไม่สำเร็จ: {learnedErr}</span>
          )}
        </p>
        {!loaded ? (
          <p className="rounded-xl border border-dashed border-zinc-700 bg-zinc-900/40 px-4 py-6 text-center text-sm text-zinc-400">
            กำลังโหลดเคสที่ระบบเรียนรู้…
          </p>
        ) : showLearned.length === 0 ? (
          <p className="rounded-xl border border-dashed border-zinc-700 bg-zinc-900/40 px-4 py-6 text-center text-sm text-zinc-500">
            ยังไม่มีเคสเรียนรู้ — รอประเมินอัตโนมัติหรือกดถูก/ผิด · หรือรัน{" "}
            <code className="text-zinc-400">npm run evaluate-outcomes</code>
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {showLearned.slice(0, 24).map((c) => {
              const win = c.outcome === "win";
              const moveSign = c.movePct >= 0 ? "+" : "";
              return (
                <article
                  key={c.id}
                  className={`rounded-xl border p-4 shadow-lg shadow-black/20 ${
                    win
                      ? "border-emerald-900/60 bg-emerald-950/30"
                      : "border-rose-900/60 bg-rose-950/30"
                  }`}
                >
                  <div className="mb-1 flex items-baseline justify-between gap-2">
                    <h3 className="font-mono text-sm font-bold text-zinc-100">
                      {c.symbol}
                    </h3>
                    <span
                      className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                        win
                          ? "bg-emerald-900/80 text-emerald-300"
                          : "bg-rose-900/80 text-rose-300"
                      }`}
                    >
                      {win ? "win" : "loss"}
                    </span>
                  </div>
                  <div className="mb-2 flex flex-wrap gap-1 text-[10px] text-zinc-400">
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5">
                      {c.side === "long" ? "Long" : "Short"}
                    </span>
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5">
                      {c.horizon}
                    </span>
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono">
                      {moveSign}
                      {c.movePct.toFixed(2)}%
                    </span>
                  </div>
                  <p className="text-xs leading-relaxed text-zinc-300">{c.noteTh}</p>
                  <p className="mt-2 text-[10px] text-zinc-600">
                    {new Date(c.timestamp).toLocaleString("th-TH", {
                      timeZone: "Asia/Bangkok",
                    })}{" "}
                    (ICT)
                  </p>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
