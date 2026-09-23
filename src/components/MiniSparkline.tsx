"use client";
import { apiUrl } from "@/lib/apiBase";

import { useEffect, useMemo, useState } from "react";

/** Lightweight SVG sparkline from /api/klines closes */
export function MiniSparkline({
  symbol,
  interval = "15m",
  limit = 48,
}: {
  symbol: string;
  interval?: string;
  limit?: number;
}) {
  const [closes, setCloses] = useState<number[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    fetch(
      apiUrl(`/api/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`)
    )
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => {
        if (!cancelled) {
          setCloses(Array.isArray(j.closes) ? j.closes.map(Number) : []);
        }
      })
      .catch((e) => {
        if (!cancelled) setErr(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, interval, limit]);

  const { path, up, min, max } = useMemo(() => {
    if (closes.length < 2) {
      return { path: "", up: true, min: 0, max: 0 };
    }
    const lo = Math.min(...closes);
    const hi = Math.max(...closes);
    const span = hi - lo || 1;
    const w = 200;
    const h = 48;
    const pts = closes.map((c, i) => {
      const x = (i / (closes.length - 1)) * w;
      const y = h - ((c - lo) / span) * (h - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return {
      path: `M ${pts.join(" L ")}`,
      up: closes[closes.length - 1] >= closes[0],
      min: lo,
      max: hi,
    };
  }, [closes]);

  if (loading) {
    return <p className="text-[10px] text-zinc-500">กำลังโหลดชาร์ต…</p>;
  }
  if (err || !path) {
    return (
      <p className="text-[10px] text-zinc-600">
        {err ? "ชาร์ตโหลดไม่ได้" : "ไม่มีข้อมูล kline"}
      </p>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-950/50 p-2">
      <div className="mb-1 flex items-center justify-between text-[10px] text-zinc-500">
        <span>
          Mini {interval} ({closes.length} แท่ง)
        </span>
        <span className={up ? "text-emerald-400" : "text-rose-400"}>
          {up ? "↑" : "↓"}
        </span>
      </div>
      <svg viewBox="0 0 200 48" className="h-12 w-full" preserveAspectRatio="none">
        <path
          d={path}
          fill="none"
          stroke={up ? "#34d399" : "#fb7185"}
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="mt-0.5 flex justify-between font-mono text-[9px] text-zinc-600">
        <span>{min.toPrecision(4)}</span>
        <span>{max.toPrecision(4)}</span>
      </div>
    </div>
  );
}
