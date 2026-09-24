"use client";

import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "@/lib/apiBase";

type Factor = { key: string; labelTh?: string; detailTh: string };
type Plan = { entry: number; sl: number; slPct: number; tp1: number; tp2: number; slSkip: boolean; slNoteTh?: string };
type Row = {
  id: string;
  type: "watch" | "ignition";
  tier?: "accumulation" | "distribution";
  symbol: string;
  side: "long" | "short";
  price: number;
  pct24h?: number | null;
  factors: Factor[];
  factorCount: number;
  flaggedAt: string;
  firstFlaggedAt: string;
  telegram: string;
  trigger?: { moveWindow: number; movePct: number; volMult: number; breakoutPct: number } | null;
  plan?: Plan | null;
  trade?: { tp1: boolean; tp2: boolean; r: number } | null;
};
type Stat = { n: number; days?: number; perDay?: number | null; tp1Rate: number | null; tp1Wilson?: number[]; expR: number; maxConsecLoss?: number; avgSlPct?: number | null };
type TierInfo = {
  params?: Record<string, number | string | boolean>;
  oos?: Stat | null;
  baselines?: { priceOnly?: Stat | null; random?: Stat | null } | null;
  verdict?: { telegram: boolean; reason: string } | null;
};
type LiveStat = { sent: { n: number; tp1Rate: number | null; avgR: number | null }; all: { n: number; tp1Rate: number | null; avgR: number | null } };
type Resp = {
  updatedAt: string | null;
  rules?: Record<string, number>;
  risk?: Record<string, number>;
  telegram?: Record<string, boolean>;
  tiers?: Record<string, TierInfo>;
  backtest?: { generatedAt?: string; data?: { symbols?: number; trainDays?: number; testDays?: number } } | null;
  live?: Record<string, LiveStat>;
  watch: Row[];
  ignition: Row[];
  noteTh?: string;
  meta?: { softFail?: boolean; reason?: string };
};

const REFRESH_MS = 60_000;
const LS_KEY = "cps-early-tiers-last-good";
const LABELS: Record<string, string> = {
  oiBuild: "OI สะสมขณะราคานิ่ง",
  funding: "funding เอียงฝั่งตรงข้าม",
  crowded: "ฝั่งตรงข้ามแน่น (L/S)",
  taker: "แรง taker เอียง",
  inflow: "วอลุ่มไหลเข้าเงียบ",
  spot: "spot นำ",
  fade: "พุ่งแรงแล้วหมดแรง",
  smart: "รายใหญ่สวนรายย่อย (top trader)",
};
const TIER_NAMES: Record<string, string> = {
  watch_long: "👀 กำลังสะสม (Long)",
  watch_short: "👀 กำลังแจกของ (Short)",
  ignition_long: "🚀 เริ่มขยับ (Long)",
  ignition_short: "🔻 เริ่มทุบ (Short)",
};
const TG_KEY: Record<string, string> = { watch_long: "watchLong", watch_short: "watchShort", ignition_long: "ignitionLong", ignition_short: "ignitionShort" };

function ago(iso: string | null | undefined): string {
  if (!iso) return "?";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "?";
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} นาทีที่แล้ว`;
  const h = m / 60;
  return `${h.toFixed(h < 10 ? 1 : 0)} ชม.ที่แล้ว`;
}
function fmtPrice(v: number): string {
  if (!Number.isFinite(v)) return "?";
  if (v >= 1) return v.toFixed(4);
  if (v >= 0.01) return v.toFixed(5);
  return v.toPrecision(4);
}
function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "?";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}
const fmtR = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "?" : `${v > 0 ? "+" : ""}${v.toFixed(2)}R`);
function title(r: Row): string {
  if (r.type === "watch") return r.side === "long" ? "👀 กำลังสะสม" : "👀 กำลังแจกของ";
  return r.side === "long" ? "🚀 เริ่มขยับ" : "🔻 เริ่มทุบ";
}
function tgText(t: string): string {
  if (t === "sent") return "ส่งแล้ว";
  if (t === "sl_wide") return "ไม่ส่ง: SL กว้างเกิน";
  if (t === "off") return "ปิด (เว็บอย่างเดียว)";
  if (t === "capped") return "ไม่ส่ง: เกินโควตา";
  return t;
}

function PlanBox({ p, side }: { p: Plan; side: "long" | "short" }) {
  const pct = (x: number) => fmtPct((x / p.entry - 1) * 100);
  return (
    <div className={`mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 rounded border px-2 py-1 text-[11px] sm:grid-cols-4 ${p.slSkip ? "border-amber-800/60 text-amber-200" : "border-zinc-700 text-zinc-200"}`}>
      <span>🎯 เข้า {fmtPrice(p.entry)}</span>
      <span>🛑 SL {fmtPrice(p.sl)} ({side === "long" ? "-" : "+"}{p.slPct.toFixed(2)}%)</span>
      <span>✅ TP1 {fmtPrice(p.tp1)} ({pct(p.tp1)})</span>
      <span>✅ TP2 {fmtPrice(p.tp2)} ({pct(p.tp2)})</span>
      {p.slSkip && <span className="col-span-full">⚠️ SL กว้างเกิน (โครงสร้างต้องการ &gt;3%) — ไม่ส่ง Telegram</span>}
    </div>
  );
}

function RowCard({ r }: { r: Row }) {
  const long = r.side === "long";
  return (
    <li className={`rounded-lg border px-3 py-2 ${long ? "border-emerald-800/60 bg-emerald-950/30" : "border-rose-800/60 bg-rose-950/30"}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="font-semibold">
          <span className="mr-1">{title(r)}</span>
          <span className="text-zinc-100">{r.symbol.replace(/USDT$/, "")}</span>
          <span className={`ml-2 rounded px-1.5 py-0.5 text-[10px] uppercase ${long ? "bg-emerald-800/60 text-emerald-100" : "bg-rose-800/60 text-rose-100"}`}>{long ? "Long" : "Short"}</span>
        </div>
        <div className="text-xs text-zinc-300">
          ราคา {fmtPrice(r.price)} · 24h {fmtPct(r.pct24h)} · หลักฐาน <strong>{r.factorCount}</strong> ข้อ
        </div>
      </div>
      {r.plan && <PlanBox p={r.plan} side={r.side} />}
      <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-xs text-zinc-200">
        {r.factors.map((f, i) => (
          <li key={i}>
            <span className="text-zinc-400">{f.labelTh || LABELS[f.key] || f.key}:</span> {f.detailTh}
          </li>
        ))}
      </ol>
      {r.trigger && (
        <div className="mt-1 text-[11px] text-zinc-400">
          จังหวะราคา: {r.trigger.moveWindow}m {fmtPct(r.trigger.movePct)} · วอลุ่ม ×{r.trigger.volMult} · breakout {fmtPct(r.trigger.breakoutPct)}
        </div>
      )}
      <div className="mt-1 text-[11px] text-zinc-500">
        ติดครั้งแรก {ago(r.firstFlaggedAt)} · ล่าสุด {ago(r.flaggedAt)} · Telegram: {tgText(r.telegram)}
        {r.trade ? ` · ผล: ${r.trade.tp1 ? "ถึง TP1" : "ไม่ถึง TP1"} ${fmtR(r.trade.r)}` : ""}
      </div>
    </li>
  );
}

function TierStats({ data }: { data: Resp | null }) {
  const tiers = data?.tiers;
  if (!tiers) return null;
  const bt = data?.backtest?.data;
  return (
    <div className="mb-3 overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-[11px] text-zinc-300">
        <thead className="text-zinc-500">
          <tr>
            <th className="py-1 pr-2">ระดับ</th>
            <th className="pr-2">Telegram</th>
            <th className="pr-2">OOS ถึง TP1 ก่อน SL</th>
            <th className="pr-2">คาดหวัง/ไม้</th>
            <th className="pr-2">แพ้ติดสูงสุด</th>
            <th className="pr-2">เทียบ price-only / สุ่ม</th>
            <th className="pr-2">สดจริง (ส่งแล้ว)</th>
          </tr>
        </thead>
        <tbody>
          {Object.keys(TIER_NAMES).map((k) => {
            const t = tiers[k] || {};
            const on = !!data?.telegram?.[TG_KEY[k]];
            const o = t.oos;
            const lv = data?.live?.[k];
            return (
              <tr key={k} className="border-t border-zinc-800">
                <td className="py-1 pr-2 font-semibold text-zinc-200">{TIER_NAMES[k]}</td>
                <td className="pr-2">
                  <span className={`rounded px-1.5 py-0.5 ${on ? "bg-emerald-800/70 text-emerald-100" : "bg-zinc-800 text-zinc-400"}`}>{on ? "Telegram: เปิด" : "Telegram: ปิด"}</span>
                </td>
                <td className="pr-2">{o && o.n ? `${o.tp1Rate}% จาก ${o.n} ครั้ง` : "—"}{o?.tp1Wilson ? <span className="text-zinc-500"> [{o.tp1Wilson[0]}–{o.tp1Wilson[1]}%]</span> : null}</td>
                <td className={`pr-2 ${o && o.expR > 0 ? "text-emerald-300" : "text-rose-300"}`}>{o && o.n ? fmtR(o.expR) : "—"}</td>
                <td className="pr-2">{o?.maxConsecLoss ?? "—"}</td>
                <td className="pr-2 text-zinc-400">
                  {t.baselines?.priceOnly ? `${t.baselines.priceOnly.tp1Rate ?? "?"}% ${fmtR(t.baselines.priceOnly.expR)}` : "—"} / {t.baselines?.random ? `${t.baselines.random.tp1Rate ?? "?"}% ${fmtR(t.baselines.random.expR)}` : "—"}
                </td>
                <td className="pr-2 text-zinc-400">{lv && lv.sent.n ? `${lv.sent.tp1Rate}% (${lv.sent.n}) ${fmtR(lv.sent.avgR)}` : lv && lv.all.n ? `ทั้งหมด ${lv.all.tp1Rate}% (${lv.all.n})` : "รอผล"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-1 text-[10px] text-zinc-500">
        Walk-forward: จูน {bt?.trainDays ?? "?"} วันแรก แล้วทดสอบ {bt?.testDays ?? "?"} วันหลังแบบไม่แตะพารามิเตอร์ (OOS) · {bt?.symbols ?? "?"} เหรียญ · SL ตามโครงสร้าง เพดาน {data?.risk?.maxSlPct ?? 2.5}% (เกิน {data?.risk?.skipSlPct ?? 3}% ไม่ส่ง) · TP1 {data?.risk?.tp1R ?? 1.5}R / TP2 {data?.risk?.tp2R ?? 3}R · หักค่าธรรมเนียม+สลิป {data?.risk?.costPct ?? 0.1}%
      </p>
    </div>
  );
}

function Group({ title, hint, rows, empty }: { title: string; hint: string; rows: Row[]; empty: string }) {
  return (
    <div className="min-w-0 flex-1">
      <h3 className="text-sm font-semibold text-zinc-100">{title} <span className="text-xs font-normal text-zinc-400">({rows.length})</span></h3>
      <p className="mb-2 text-[11px] text-zinc-500">{hint}</p>
      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-700 px-3 py-4 text-center text-xs text-zinc-400">{empty}</div>
      ) : (
        <ul className="space-y-2">{rows.map((r) => <RowCard key={r.id} r={r} />)}</ul>
      )}
    </div>
  );
}

export function EarlyTiersPanel() {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(apiUrl("/api/early-tiers"), { cache: "no-store" });
      const j = (await res.json().catch(() => null)) as Resp | null;
      if (!j || !res.ok || !j.updatedAt) throw new Error(j?.meta?.reason || `HTTP ${res.status}`);
      setData(j);
      setStale(res.headers.get("X-Early-Tiers-Stale") === "1");
      setError(null);
      try { localStorage.setItem(LS_KEY, JSON.stringify(j)); } catch { /* ignore */ }
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setData((cur) => {
        if (cur) return cur;
        try { const s = localStorage.getItem(LS_KEY); return s ? (JSON.parse(s) as Resp) : null; } catch { return null; }
      });
      setStale(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const rules = data?.rules;
  const oldMs = data?.updatedAt ? Date.now() - Date.parse(data.updatedAt) : 0;
  return (
    <section id="early-tiers" className="mt-4 rounded-xl border border-sky-900/50 bg-zinc-900/60 px-3 py-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-bold text-sky-200">ระยะต้น (หลักฐานซ่อนก่อน → ราคาเป็นแค่จังหวะ)</h2>
        <span className="text-[11px] text-zinc-500">
          อัปเดต {data?.updatedAt ? ago(data.updatedAt) : "—"}
          {rules ? ` · ต้องมีหลักฐานซ่อน ≥3 ข้อเสมอ` : ""}
        </span>
      </div>
      {(error || stale || oldMs > 10 * 60e3) && (
        <div className="mb-2 rounded border border-amber-800/60 bg-amber-950/40 px-2 py-1 text-xs text-amber-200">
          {data ? `แสดงข้อมูลล่าสุดที่มี (อัปเดต ${ago(data.updatedAt)})` : "ดึงข้อมูลไม่ได้"}{error ? ` · ${error}` : ""}
        </div>
      )}
      <TierStats data={data} />
      <div className="flex flex-col gap-4 md:flex-row">
        <Group
          title="เฝ้าดู: กำลังสะสม / กำลังแจกของ"
          hint="OI สะสมขณะราคานิ่ง + หลักฐานอื่น (funding, L/S, taker, spot, top trader)"
          rows={data?.watch ?? []}
          empty="ตอนนี้ยังไม่มีเหรียญที่หลักฐานครบเกณฑ์"
        />
        <Group
          title="ระยะต้น: เริ่มขยับ / เริ่มทุบ"
          hint="ราคาเพิ่งเบรก หลังมีหลักฐานครบก่อนหน้า — ราคาขยับอย่างเดียวไม่นับ"
          rows={data?.ignition ?? []}
          empty="ยังไม่มีสัญญาณระยะต้นที่ผ่านเกณฑ์ confluence"
        />
      </div>
      <p className="mt-2 text-[11px] text-zinc-500">สัญญาณระยะต้น เสี่ยงหลอกสูง · ใช้ SL ทุกครั้ง · ไม่ใช่คำแนะนำการลงทุน</p>
    </section>
  );
}
