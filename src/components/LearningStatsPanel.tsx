"use client";

import { useCallback, useEffect, useState } from "react";

interface SideStat {
  wins: number;
  losses: number;
  neutrals: number;
  graded: number;
  winRate: number | null;
}

interface StatsPayload {
  updatedAt: string;
  rollingN: number;
  long: SideStat;
  short: SideStat;
  totalCases: number;
  paperPnl?: {
    longSum: number;
    shortSum: number;
    totalSum: number;
    longAvg: number | null;
    shortAvg: number | null;
    totalAvg: number | null;
  };
  paperPnlPctSum?: number;
  thresholds: {
    source: string;
    nowLongMinScore: number;
    nowShortMinScore: number;
    nowLongPctMax: number;
    nowShortPctMin: number;
    defaults?: {
      nowLongMinScore: number;
      nowShortMinScore: number;
      nowLongPctMax: number;
      nowShortPctMin: number;
    };
  };
  empty?: boolean;
  emptyMessageTh?: string;
  disclaimerTh?: string;
}

interface AlertSettingsPayload {
  mode: "all" | "sharp";
  minLongScore: number;
  minShortScore: number;
  labelsTh?: { all: string; sharp: string };
}

function fmtWr(wr: number | null) {
  if (wr == null) return "—";
  return `${(wr * 100).toFixed(0)}%`;
}

function fmtPnl(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

export function LearningStatsPanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [settings, setSettings] = useState<AlertSettingsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [sRes, aRes] = await Promise.all([
        fetch("/api/learning-stats", { cache: "no-store" }),
        fetch("/api/alert-settings", { cache: "no-store" }),
      ]);
      if (!sRes.ok) throw new Error(`stats HTTP ${sRes.status}`);
      const sJson = (await sRes.json()) as StatsPayload;
      setStats(sJson);
      if (aRes.ok) {
        setSettings((await aRes.json()) as AlertSettingsPayload);
      }
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function setMode(mode: "all" | "sharp") {
    setToggling(true);
    try {
      const res = await fetch("/api/alert-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as AlertSettingsPayload;
      setSettings(j);
    } catch (e) {
      setError(String(e));
    } finally {
      setToggling(false);
    }
  }

  const empty =
    !stats ||
    stats.empty ||
    (stats.long.graded === 0 && stats.short.graded === 0 && stats.totalCases === 0);

  return (
    <section className="mt-4 rounded-xl border border-sky-900/50 bg-sky-950/20 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-sky-300">
          สถิติการเรียนรู้{" "}
          <span className="text-xs font-normal text-zinc-500">
            (Learning stats · rolling)
          </span>
        </h2>
        <div className="flex items-center gap-2 text-[10px]">
          <span className="text-zinc-500">Telegram:</span>
          <button
            type="button"
            disabled={toggling || settings?.mode === "all"}
            onClick={() => void setMode("all")}
            className={`rounded-md px-2 py-1 font-medium ring-1 ${
              settings?.mode === "all"
                ? "bg-zinc-200 text-zinc-900 ring-zinc-300"
                : "bg-zinc-900 text-zinc-400 ring-zinc-700 hover:text-zinc-200"
            }`}
          >
            ส่งทั้งหมด
          </button>
          <button
            type="button"
            disabled={toggling || settings?.mode === "sharp"}
            onClick={() => void setMode("sharp")}
            className={`rounded-md px-2 py-1 font-medium ring-1 ${
              settings?.mode === "sharp"
                ? "bg-orange-500 text-black ring-orange-400"
                : "bg-zinc-900 text-zinc-400 ring-zinc-700 hover:text-zinc-200"
            }`}
          >
            เฉพาะสัญญาณคม
          </button>
        </div>
      </div>

      {error && (
        <p className="mb-2 text-xs text-rose-400">โหลดไม่สำเร็จ: {error}</p>
      )}

      {empty ? (
        <p className="rounded-lg border border-dashed border-zinc-700 bg-zinc-950/40 px-3 py-4 text-center text-sm text-zinc-500">
          {stats?.emptyMessageTh ||
            "ยังไม่มีเคสเรียนรู้ — รอประเมินอัตโนมัติหรือกดถูก/ผิด"}
        </p>
      ) : (
        stats && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              title="Long WR"
              value={fmtWr(stats.long.winRate)}
              sub={`${stats.long.wins}W / ${stats.long.losses}L · graded ${stats.long.graded}`}
              tone="emerald"
            />
            <StatCard
              title="Short WR"
              value={fmtWr(stats.short.winRate)}
              sub={`${stats.short.wins}W / ${stats.short.losses}L · graded ${stats.short.graded}`}
              tone="rose"
            />
            <StatCard
              title="NOW thresholds"
              value={`L≥${stats.thresholds.nowLongMinScore} · S≥${stats.thresholds.nowShortMinScore}`}
              sub={
                stats.thresholds.source === "learned"
                  ? `learned · pct L≤${stats.thresholds.nowLongPctMax}% · S≥${stats.thresholds.nowShortPctMin}%`
                  : `defaults · pct L≤${stats.thresholds.defaults?.nowLongPctMax ?? 18}% · S≥${stats.thresholds.defaults?.nowShortPctMin ?? -18}%`
              }
              tone="amber"
            />
            <StatCard
              title="Paper P&L (heuristic)"
              value={fmtPnl(stats.paperPnl?.totalSum ?? stats.paperPnlPctSum)}
              sub={`Long ${fmtPnl(stats.paperPnl?.longSum)} · Short ${fmtPnl(stats.paperPnl?.shortSum)} · avg ${fmtPnl(stats.paperPnl?.totalAvg)}`}
              tone="sky"
            />
          </div>
        )
      )}

      <p className="mt-3 text-[10px] leading-relaxed text-zinc-500">
        {stats?.disclaimerTh ||
          "สถิติ heuristic — ไม่ใช่ผลตอบแทนจริง และไม่ใช่คำแนะนำการลงทุน"}
        {settings && (
          <span className="ml-1">
            · โหมดแจ้งเตือน:{" "}
            {settings.mode === "sharp" ? "เฉพาะสัญญาณคม" : "ส่งทั้งหมด"}
            {settings.mode === "sharp" &&
              ` (min L≥${settings.minLongScore} / S≥${settings.minShortScore})`}
          </span>
        )}
      </p>
    </section>
  );
}

function StatCard({
  title,
  value,
  sub,
  tone,
}: {
  title: string;
  value: string;
  sub: string;
  tone: "emerald" | "rose" | "amber" | "sky";
}) {
  const valueColor =
    tone === "emerald"
      ? "text-emerald-300"
      : tone === "rose"
        ? "text-rose-300"
        : tone === "amber"
          ? "text-amber-300"
          : "text-sky-300";
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">
        {title}
      </div>
      <div className={`mt-0.5 font-mono text-lg font-bold ${valueColor}`}>
        {value}
      </div>
      <div className="mt-0.5 text-[10px] text-zinc-500">{sub}</div>
    </div>
  );
}
