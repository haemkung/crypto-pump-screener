"use client";

import { useEffect, useState } from "react";
import type { ScreenMode, ScreenRow } from "@/lib/types";
import {
  fmtFunding,
  fmtPct,
  fmtPrice,
  fmtRatio,
  fmtVol,
  flagLabelTh,
  entryModeBadgeClass,
} from "@/lib/format";

interface DetailPayload {
  oiChangePct: number | null;
  openInterest: { openInterest: string; time: number } | null;
  globalLongShortAccountRatio: { longShortRatio: string }[] | null;
  topLongShortPositionRatio: { longShortRatio: string }[] | null;
  takerLongShortRatio: { buySellRatio: string }[] | null;
  error?: string;
}

export function DetailPanel({
  row,
  mode,
  onClose,
}: {
  row: ScreenRow;
  mode: ScreenMode;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<DetailPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const isShort = mode === "short";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDetail(null);
    fetch(`/api/oi-detail?symbol=${encodeURIComponent(row.symbol)}`)
      .then(async (r) => {
        const j = await r.json();
        if (!cancelled) setDetail(j);
      })
      .catch((e) => {
        if (!cancelled)
          setDetail({
            error: String(e),
            oiChangePct: null,
            openInterest: null,
            globalLongShortAccountRatio: null,
            topLongShortPositionRatio: null,
            takerLongShortRatio: null,
          });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [row.symbol]);

  const entry = isShort ? row.shortEntry : row.entry;
  const flags = isShort ? row.shortFlags : row.flags;
  const score = isShort ? row.shortScore : row.score;
  const bLong = row.breakdown;
  const bShort = row.shortBreakdown;

  const fundingTone = isShort
    ? row.lastFundingRate != null && row.lastFundingRate > 0
      ? ("up" as const)
      : undefined
    : row.lastFundingRate != null && row.lastFundingRate < 0
      ? ("up" as const)
      : undefined;

  return (
    <aside className="flex h-full flex-col rounded-xl border border-zinc-700 bg-zinc-900 p-4 shadow-2xl">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h3 className="text-xl font-bold text-white">{row.baseAsset}</h3>
          <p className="font-mono text-sm text-zinc-400">{row.symbol}</p>
          <p className="mt-1 text-[10px] uppercase tracking-wide text-zinc-500">
            โหมด: {isShort ? "Short (ขาลง)" : "Long (ขาขึ้น)"}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-white"
        >
          ปิด
        </button>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-2 text-sm">
        <Stat label="ราคา" value={fmtPrice(row.price)} />
        <Stat
          label="24h %"
          value={fmtPct(row.priceChangePercent)}
          tone={row.priceChangePercent >= 0 ? "up" : "down"}
        />
        <Stat label="Vol (Fut)" value={fmtVol(row.quoteVolume)} />
        <Stat
          label="Funding"
          value={fmtFunding(row.lastFundingRate)}
          tone={fundingTone}
        />
        <Stat
          label="Fut/Spot"
          value={row.hasSpot ? fmtRatio(row.futSpotRatio) : "ไม่มี Spot"}
        />
        <Stat
          label={isShort ? "Short Score" : "Long Score"}
          value={String(score)}
          tone="score"
        />
      </div>

      {row.urgency && (
        <div className="mb-4 animate-pulse rounded-xl border-2 border-orange-500/70 bg-gradient-to-br from-orange-950 to-rose-950 p-3">
          <div className="mb-1 flex items-center gap-2">
            <span className="rounded bg-orange-500 px-1.5 py-0.5 text-[10px] font-black uppercase text-black">
              ตอนนี้
            </span>
            <span className="text-sm font-bold text-orange-100">
              {row.urgencyLabelTh}
            </span>
          </div>
          <p className="mb-1 text-xs text-orange-100/90">{row.urgencyReasonTh}</p>
          <p className="mb-2 text-xs font-medium text-rose-200">{row.missRiskTh}</p>
          <p className="text-[10px] leading-relaxed text-orange-200/60">
            &quot;เข้าตอนนี้&quot; เป็น heuristic จากแพทเทิร์น ไม่ใช่คำสั่งซื้อ/ขาย และไม่ใช่คำแนะนำการลงทุน
          </p>
        </div>
      )}

      {entry && (
        <div className="mb-4 rounded-lg border border-zinc-700 bg-zinc-950/50 p-3">
          <div className="mb-2 flex items-center gap-2">
            <h4 className="text-sm font-semibold text-amber-300">
              {isShort ? "จุด Short (heuristic)" : "จุดเข้า (heuristic)"}
            </h4>
            <span
              className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ${entryModeBadgeClass(entry.mode)}`}
            >
              {entry.labelTh}
            </span>
          </div>
          {entry.entryLow != null && entry.entryHigh != null ? (
            <p className="mb-1 font-mono text-sm text-zinc-200">
              โซน: {fmtPrice(entry.entryLow)} – {fmtPrice(entry.entryHigh)}
            </p>
          ) : (
            <p className="mb-1 text-sm text-zinc-400">ไม่มีโซนเข้าแนะนำ</p>
          )}
          <p className="mb-1 text-xs text-zinc-300">{entry.entryNote}</p>
          <p className="mb-2 text-xs text-zinc-500">
            <span className="text-zinc-400">Invalidation:</span>{" "}
            {entry.invalidation}
          </p>
          <p className="text-[10px] leading-relaxed text-amber-200/70">
            {isShort
              ? "จุด Short เป็น heuristic จากแพทเทิร์น ไม่ใช่คำสั่งขายชอร์ต — ขาลงอาจเด้งแรง / squeeze ได้"
              : "จุดเข้าเป็น heuristic จากแพทเทิร์น ไม่ใช่คำสั่งซื้อ"}
          </p>
        </div>
      )}

      <h4 className="mb-2 text-sm font-semibold text-amber-300">
        {isShort ? "องค์ประกอบ Short Score" : "องค์ประกอบคะแนน"}
      </h4>
      {isShort ? (
        <ul className="mb-3 space-y-1 text-xs text-zinc-300">
          <li>
            Early drop:{" "}
            <span className="text-rose-400">{bShort.earlyDrop}</span> / 25
          </li>
          <li>
            Volume: <span className="text-emerald-400">{bShort.volume}</span> / 30
          </li>
          <li>
            Funding+: <span className="text-emerald-400">{bShort.funding}</span>{" "}
            / 20
          </li>
          <li>
            Liquidity proxy:{" "}
            <span className="text-emerald-400">{bShort.liquidity}</span> / 15
          </li>
          <li>
            OI change:{" "}
            <span className="text-emerald-400">{bShort.oiChange}</span> / 10
          </li>
          <li className="pt-1 font-semibold text-white">รวม: {bShort.total}</li>
        </ul>
      ) : (
        <ul className="mb-3 space-y-1 text-xs text-zinc-300">
          <li>
            Early move:{" "}
            <span className="text-emerald-400">{bLong.earlyMove}</span> / 25
          </li>
          <li>
            Volume: <span className="text-emerald-400">{bLong.volume}</span> / 30
          </li>
          <li>
            Funding: <span className="text-emerald-400">{bLong.funding}</span> / 20
          </li>
          <li>
            Liquidity proxy:{" "}
            <span className="text-emerald-400">{bLong.liquidity}</span> / 15
          </li>
          <li>
            OI change: <span className="text-emerald-400">{bLong.oiChange}</span>{" "}
            / 10
          </li>
          <li className="pt-1 font-semibold text-white">รวม: {bLong.total}</li>
        </ul>
      )}

      <div className="mb-3 flex flex-wrap gap-1">
        {flags.map((f) => (
          <span
            key={f}
            className="rounded-md bg-violet-950/80 px-1.5 py-0.5 text-[10px] text-violet-300 ring-1 ring-violet-800"
          >
            {flagLabelTh(f)}
          </span>
        ))}
      </div>

      {row.catalystNote && (
        <p className="mb-3 rounded-lg border border-amber-900/50 bg-amber-950/40 p-2 text-xs text-amber-200">
          {row.catalystNote}
        </p>
      )}

      <h4 className="mb-2 text-sm font-semibold text-amber-300">หมายเหตุคะแนน</h4>
      <ul className="mb-4 max-h-32 list-disc space-y-1 overflow-y-auto pl-4 text-xs text-zinc-400">
        {(isShort ? bShort.notes : bLong.notes).map((n, i) => (
          <li key={i}>{n}</li>
        ))}
      </ul>

      {isShort && (
        <p className="mb-4 rounded-lg border border-rose-900/40 bg-rose-950/30 px-2 py-1.5 text-[10px] leading-relaxed text-rose-200/80">
          ขา Short อาจเด้งแรง / long squeeze ได้ทุกเมื่อ — เป็น heuristic
          สำหรับวิจัย ไม่ใช่คำสั่งเทรด
        </p>
      )}

      <h4 className="mb-2 text-sm font-semibold text-amber-300">
        OI / L/S (lazy load)
      </h4>
      {loading && <p className="text-xs text-zinc-500">กำลังโหลด…</p>}
      {!loading && detail && (
        <div className="space-y-1 text-xs text-zinc-300">
          {"error" in detail && detail.error ? (
            <p className="text-red-400">{detail.error}</p>
          ) : (
            <>
              <p>
                OI ปัจจุบัน:{" "}
                {detail.openInterest?.openInterest
                  ? fmtVol(Number(detail.openInterest.openInterest))
                  : "—"}
              </p>
              <p>
                OI % change (hist):{" "}
                {fmtPct(detail.oiChangePct ?? row.oiChangePct)}
              </p>
              <p>
                Global L/S:{" "}
                {detail.globalLongShortAccountRatio?.[0]?.longShortRatio ?? "—"}
              </p>
              <p>
                Top position L/S:{" "}
                {detail.topLongShortPositionRatio?.[0]?.longShortRatio ?? "—"}
              </p>
              <p>
                Taker buy/sell:{" "}
                {detail.takerLongShortRatio?.[0]?.buySellRatio ?? "—"}
              </p>
            </>
          )}
        </div>
      )}
    </aside>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "up" | "down" | "score";
}) {
  const color =
    tone === "up"
      ? "text-emerald-400"
      : tone === "down"
        ? "text-rose-400"
        : tone === "score"
          ? "text-amber-300"
          : "text-zinc-100";
  return (
    <div className="rounded-lg bg-zinc-950/60 px-2 py-1.5">
      <div className="text-[10px] text-zinc-500">{label}</div>
      <div className={`font-mono text-sm ${color}`}>{value}</div>
    </div>
  );
}
