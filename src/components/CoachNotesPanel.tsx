"use client";

import { useEffect, useState } from "react";
import { fmtBangkok } from "@/lib/format";
import { apiUrl } from "@/lib/apiBase";

interface CoachNote {
  id: string;
  symbol: string;
  side: string;
  outcome: string;
  noteTh: string;
  timestamp: string;
  source?: string;
  tier?: string | null;
  labelTh?: string | null;
}

interface InsightsPayload {
  empty?: boolean;
  mistakes?: Array<{ noteTh: string }>;
  adjustments?: Array<{ noteTh: string }>;
  wins?: Array<{ noteTh: string }>;
  stats?: { earlyWinRate?: number | null; earlyGraded?: number };
}

export function CoachNotesPanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const [notes, setNotes] = useState<CoachNote[]>([]);
  const [insights, setInsights] = useState<InsightsPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(apiUrl("/api/coach-notes?limit=10")).then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
      fetch(apiUrl("/api/learning-insights"), { cache: "no-store" }).then(
        async (r) => (r.ok ? r.json() : null)
      ),
    ])
      .then(([j, ins]) => {
        if (cancelled) return;
        setNotes(Array.isArray(j.notes) ? j.notes : []);
        setInsights(ins);
      })
      .catch((e) => {
        if (!cancelled) setErr(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (!loaded) {
    return (
      <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-xs text-zinc-400">
        โค้ชหลังเทรด: กำลังโหลด…
      </div>
    );
  }
  if (err) {
    return (
      <div className="mt-4 rounded-xl border border-rose-900/50 bg-rose-950/20 px-3 py-2 text-xs text-rose-300">
        โค้ชหลังเทรด โหลดไม่สำเร็จ
      </div>
    );
  }

  const hasInsights =
    insights &&
    !insights.empty &&
    ((insights.mistakes && insights.mistakes.length > 0) ||
      (insights.adjustments && insights.adjustments.length > 0));

  if (notes.length === 0 && !hasInsights) {
    return (
      <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-xs text-zinc-500">
        โค้ชหลังเทรด: ยังไม่มีโน้ต — รัน evaluate-outcomes / learn-from-mistakes หลังเกรด
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-xl border border-violet-900/40 bg-violet-950/20 px-3 py-2">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-violet-300">
          โค้ชหลังเทรด + เรียนรู้ความผิดพลาด
        </span>
        <span className="text-[10px] text-zinc-500">
          ล่าสุด {notes.length} รายการ
          {insights?.stats?.earlyGraded
            ? ` · Early WR ${
                insights.stats.earlyWinRate != null
                  ? `${(insights.stats.earlyWinRate * 100).toFixed(0)}%`
                  : "—"
              }`
            : ""}
        </span>
      </div>

      {hasInsights && (
        <div className="mb-2 space-y-1 rounded-lg border border-amber-900/30 bg-amber-950/20 px-2 py-1.5 text-[11px]">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-400">
            บทเรียนที่ปรับเข้า AI แล้ว
          </div>
          {(insights?.mistakes || []).slice(0, 3).map((m, i) => (
            <div key={`im-${i}`} className="leading-relaxed text-rose-200/90">
              {m.noteTh}
            </div>
          ))}
          {(insights?.adjustments || []).slice(0, 2).map((a, i) => (
            <div key={`ia-${i}`} className="leading-relaxed text-amber-100/85">
              🔧 {a.noteTh}
            </div>
          ))}
        </div>
      )}

      <ul className="max-h-40 space-y-1 overflow-y-auto text-[11px] leading-relaxed text-zinc-300">
        {notes.map((n) => (
          <li key={n.id} className="border-b border-zinc-800/80 pb-1 last:border-0">
            <span
              className={
                n.outcome === "win"
                  ? "text-emerald-400"
                  : n.outcome === "loss"
                    ? "text-rose-400"
                    : n.source === "learn"
                      ? "text-amber-300"
                      : "text-zinc-400"
              }
            >
              {n.noteTh}
            </span>
            <span className="ml-2 text-[9px] text-zinc-600">
              {fmtBangkok(n.timestamp)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
