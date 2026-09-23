"use client";

import { useEffect, useState } from "react";
import { fmtBangkok } from "@/lib/format";

interface CoachNote {
  id: string;
  symbol: string;
  side: string;
  outcome: string;
  noteTh: string;
  timestamp: string;
}

export function CoachNotesPanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const [notes, setNotes] = useState<CoachNote[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/coach-notes?limit=8")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => {
        if (!cancelled) setNotes(Array.isArray(j.notes) ? j.notes : []);
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
  if (notes.length === 0) {
    return (
      <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-xs text-zinc-500">
        โค้ชหลังเทรด: ยังไม่มีโน้ต — รัน evaluate-outcomes / post-trade-coach หลังเกรด
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-xl border border-violet-900/40 bg-violet-950/20 px-3 py-2">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-xs font-semibold text-violet-300">
          โค้ชหลังเทรด (heuristic)
        </span>
        <span className="text-[10px] text-zinc-500">ล่าสุด {notes.length} รายการ</span>
      </div>
      <ul className="max-h-36 space-y-1 overflow-y-auto text-[11px] leading-relaxed text-zinc-300">
        {notes.map((n) => (
          <li key={n.id} className="border-b border-zinc-800/80 pb-1 last:border-0">
            <span
              className={
                n.outcome === "win"
                  ? "text-emerald-400"
                  : n.outcome === "loss"
                    ? "text-rose-400"
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
