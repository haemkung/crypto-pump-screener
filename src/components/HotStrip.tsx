"use client";

import { useCallback, useEffect, useState } from "react";
import type { HotResponse, HotRow, ScreenRow } from "@/lib/types";
import { fmtPct, fmtVol } from "@/lib/format";
import { apiUrl } from "@/lib/apiBase";

const HOT_REFRESH_MS = 40_000;

type Props = {
  screenRows: ScreenRow[] | null;
  onSelect: (row: ScreenRow) => void;
  onSelectMode?: (mode: "long" | "short") => void;
};

export function HotStrip({ screenRows, onSelect, onSelectMode }: Props) {
  const [data, setData] = useState<HotResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lateOpen, setLateOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(true);

  const load = useCallback(async (force = false) => {
    try {
      setError(null);
      const q = force ? "?refresh=1" : "";
      const res = await fetch(apiUrl(`/api/hot${q}`));
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(
          (j as { error?: string }).error || `HTTP ${res.status}`
        );
      }
      const json = (await res.json()) as HotResponse;
      setData(json);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
    const id = setInterval(() => void load(false), HOT_REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const pick = (h: HotRow) => {
    onSelectMode?.("long");
    const full = screenRows?.find((r) => r.symbol === h.symbol);
    if (full) {
      onSelect(full);
      return;
    }
    onSelect({
      symbol: h.symbol,
      baseAsset: h.baseAsset,
      price: h.price,
      priceChangePercent: h.pct24h,
      quoteVolume: h.quoteVolume,
      lastFundingRate: null,
      markPrice: null,
      futuresVol: h.quoteVolume,
      spotVol: null,
      futSpotRatio: null,
      hasSpot: true,
      oiChangePct: null,
      longShortRatio: null,
      score: h.score,
      flags: h.flags,
      breakdown: {
        earlyMove: 0,
        volume: 0,
        funding: 0,
        liquidity: 0,
        oiChange: 0,
        total: h.score,
        notes: [],
      },
      entry: {
        mode: h.entryMode,
        labelTh: h.entryMode,
        entryLow: null,
        entryHigh: null,
        invalidation: "",
        entryNote: "",
      },
      shortScore: 0,
      shortFlags: [],
      shortBreakdown: {
        earlyDrop: 0,
        volume: 0,
        funding: 0,
        liquidity: 0,
        oiChange: 0,
        total: 0,
        notes: [],
      },
      shortEntry: {
        mode: "watch_only_short",
        labelTh: "",
        entryLow: null,
        entryHigh: null,
        invalidation: "",
        entryNote: "",
      },
      urgency: null,
      urgencyLabelTh: null,
      urgencyReasonTh: null,
      missRiskTh: null,
      mtfAlign: null,
      qualityGrade: h.qualityGrade,
      shortQualityGrade: "C",
      falsePatternRisk: false,
    });
  };

  // Fallback from screen while /api/hot loads — early band only, no score gate
  const fallbackHot: HotRow[] =
    !data && screenRows
      ? screenRows
          .filter(
            (r) =>
              r.priceChangePercent >= 5 &&
              r.priceChangePercent < 50 &&
              !r.flags.includes("late_chase") &&
              r.quoteVolume >= 300_000
          )
          .sort((a, b) => b.priceChangePercent - a.priceChangePercent)
          .slice(0, 40)
          .map((r) => ({
            symbol: r.symbol,
            baseAsset: r.baseAsset,
            price: r.price,
            pct1h: null,
            pct24h: r.priceChangePercent,
            score: r.score,
            quoteVolume: r.quoteVolume,
            flags: r.flags,
            entryMode: r.entry.mode,
            qualityGrade: r.qualityGrade,
            early: true,
            slSweep: "wait",
          }))
      : [];

  const hot = data?.hot?.length ? data.hot : fallbackHot;
  const late = data?.late ?? [];
  const visible = expanded ? hot : hot.slice(0, 16);

  if (loading && !hot.length && !late.length) {
    return (
      <div className="sticky top-0 z-40 mt-4 rounded-xl border-2 border-cyan-500/50 bg-cyan-950/40 px-4 py-3 text-sm text-cyan-100 shadow-lg">
        กำลังสแกนทุกคู่ — หาเหรียญที่กำลังเร่งตัว…
      </div>
    );
  }

  if (!hot.length && !late.length && error) {
    return null;
  }

  return (
    <div className="sticky top-0 z-40 mt-4 space-y-2">
      <div className="rounded-xl border-2 border-cyan-400 bg-gradient-to-r from-cyan-950 via-sky-950 to-emerald-950 px-4 py-3 shadow-xl shadow-cyan-500/25 ring-2 ring-cyan-300/40">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="animate-pulse rounded bg-amber-300 px-2.5 py-0.5 text-xs font-black uppercase tracking-widest text-black shadow">
            กำลังเร่งตัว
          </span>
          <span className="text-sm font-bold text-cyan-50">
            จับทุกเหรียญที่เร่งเร็ว (1h / 15m) ก่อนสาย — ไม่กรองคะแนน
          </span>
          <span className="rounded-full bg-cyan-900/80 px-2 py-0.5 font-mono text-[11px] text-cyan-200">
            {hot.length} คู่
          </span>
          <span className="text-[10px] text-cyan-200/60">
            {data?.meta?.enriched1h != null
              ? `สแกน 1h ${data.meta.enriched1h} สัญลักษณ์`
              : "รอข้อมูล 1h จาก upstream"}
          </span>
        </div>
        <p className="mb-2 text-[11px] leading-snug text-cyan-100/75">
          {data?.meta?.noteTh ??
            "สแกนทุก USDT-M ตาม %1h จริง — เหรียญแบบ BR ควรโผล่ที่นี่ตอน 24h ยังประมาณ 5–30%"}
        </p>
        {hot.length === 0 ? (
          <p className="text-xs text-zinc-400">
            ตอนนี้ยังไม่เจอตัวเร่งตามเกณฑ์ — แผงนี้รีเฟรชอัตโนมัติ
          </p>
        ) : (
          <>
            <div className="flex max-h-[40vh] flex-wrap gap-2 overflow-y-auto pb-1">
              {visible.map((h, idx) => {
                const strong =
                  (h.pct1h != null && h.pct1h >= 5) ||
                  (h.pct15m != null && h.pct15m >= 4);
                return (
                  <button
                    key={`hot-${h.symbol}`}
                    type="button"
                    onClick={() => pick(h)}
                    className={`rounded-lg border px-2.5 py-1.5 text-left transition hover:scale-[1.02] hover:border-cyan-200 ${
                      strong
                        ? "animate-pulse border-amber-400 bg-amber-950/50 ring-1 ring-amber-400/50"
                        : idx < 5
                          ? "border-cyan-400/70 bg-cyan-950/60"
                          : "border-cyan-700/40 bg-zinc-950/70"
                    }`}
                  >
                    <span className="font-bold text-cyan-100">
                      {idx < 9 ? (
                        <span className="mr-1 font-mono text-[10px] text-cyan-500">
                          #{idx + 1}
                        </span>
                      ) : null}
                      {h.baseAsset}
                    </span>
                    {h.pct1h != null && (
                      <span className="ml-2 font-mono text-xs font-semibold text-emerald-300">
                        1h {fmtPct(h.pct1h)}
                      </span>
                    )}
                    {h.pct15m != null && h.pct1h == null && (
                      <span className="ml-2 font-mono text-xs text-lime-300">
                        15m {fmtPct(h.pct15m)}
                      </span>
                    )}
                    <span className="ml-2 font-mono text-xs text-zinc-400">
                      24h {fmtPct(h.pct24h)}
                    </span>
                    <span className="ml-2 text-[10px] text-zinc-500">
                      {fmtVol(h.quoteVolume)}
                    </span>
                    <span
                      className={`ml-2 rounded px-1 py-0.5 text-[9px] font-black ${
                        h.slSweep === "swept"
                          ? "bg-emerald-400 text-black"
                          : "bg-amber-400 text-black"
                      }`}
                    >
                      {h.slSweep === "swept" ? "แท่งกลับ" : "รอ"}
                    </span>
                  </button>
                );
              })}
            </div>
            {hot.length > 16 && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="mt-2 text-[11px] font-semibold text-cyan-300 underline-offset-2 hover:underline"
              >
                {expanded
                  ? `ย่อเหลือ 16 จาก ${hot.length}`
                  : `แสดงทั้งหมด ${hot.length} คู่`}
              </button>
            )}
          </>
        )}
      </div>

      {late.length > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/90 px-3 py-2 backdrop-blur">
          <button
            type="button"
            onClick={() => setLateOpen((v) => !v)}
            className="flex w-full items-center justify-between text-left text-xs text-zinc-400 hover:text-zinc-200"
          >
            <span>
              ขึ้นไปแล้ว (สาย &gt;50%) — ไม่ใช่จุดจับต้น · {late.length} ตัว เช่น{" "}
              {late
                .slice(0, 3)
                .map((l) => l.baseAsset)
                .join(", ")}
              {late.length > 3 ? "…" : ""}
            </span>
            <span className="font-mono text-zinc-500">
              {lateOpen ? "▾" : "▸"}
            </span>
          </button>
          {lateOpen && (
            <div className="mt-2 flex flex-wrap gap-2">
              {late.map((h) => (
                <button
                  key={`late-${h.symbol}`}
                  type="button"
                  onClick={() => pick(h)}
                  className="rounded-md border border-rose-900/40 bg-rose-950/30 px-2 py-1 text-left text-xs hover:border-rose-600/60"
                >
                  <span className="font-semibold text-rose-200">
                    {h.baseAsset}
                  </span>
                  <span className="ml-2 font-mono text-rose-300/80">
                    24h {fmtPct(h.pct24h)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
