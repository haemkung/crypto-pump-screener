"use client";

import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "@/lib/apiBase";

type Factor = { key: string; labelTh?: string; detailTh: string };
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
};
type Resp = {
  updatedAt: string | null;
  daemonAt?: string | null;
  rules?: Record<string, number>;
  telegram?: Record<string, boolean>;
  watch: Row[];
  ignition: Row[];
  noteTh?: string;
  meta?: { softFail?: boolean; reason?: string };
};

const REFRESH_MS = 60_000;
const LABELS: Record<string, string> = {
  oiBuild: "OI สะสมขณะราคานิ่ง",
  funding: "funding เอียงฝั่งตรงข้าม",
  crowded: "ฝั่งตรงข้ามแน่น (L/S)",
  taker: "แรง taker เอียง",
  inflow: "วอลุ่มไหลเข้าเงียบ",
  spot: "spot นำ",
  fade: "พุ่งแรงแล้วหมดแรง",
};

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
function title(r: Row): string {
  if (r.type === "watch") return r.side === "long" ? "👀 กำลังสะสม" : "👀 กำลังแจกของ";
  return r.side === "long" ? "🚀 เริ่มขยับ" : "🔻 เริ่มทุบ";
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
      <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-xs text-zinc-200">
        {r.factors.map((f, i) => (
          <li key={i}>
            <span className="text-zinc-400">{f.labelTh || LABELS[f.key] || f.key}:</span> {f.detailTh}
          </li>
        ))}
      </ol>
      {r.trigger && (
        <div className="mt-1 text-[11px] text-zinc-400">
          trigger ราคา: {r.trigger.moveWindow}m {fmtPct(r.trigger.movePct)} · วอลุ่ม ×{r.trigger.volMult} · breakout {fmtPct(r.trigger.breakoutPct)}
        </div>
      )}
      <div className="mt-1 text-[11px] text-zinc-500">
        ติดครั้งแรก {ago(r.firstFlaggedAt)} · ล่าสุด {ago(r.flaggedAt)} · Telegram: {r.telegram === "sent" ? "ส่งแล้ว" : r.telegram === "off" ? "ปิด (ยังไม่ผ่านเกณฑ์ backtest)" : r.telegram}
      </div>
    </li>
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

  const load = useCallback(async () => {
    try {
      const res = await fetch(apiUrl("/api/early-tiers"), { cache: "no-store" });
      const j = (await res.json().catch(() => null)) as Resp | null;
      if (!j) throw new Error(`HTTP ${res.status}`);
      setData(j);
      setError(res.ok ? null : j.meta?.reason || `HTTP ${res.status}`);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const rules = data?.rules;
  return (
    <section id="early-tiers" className="mt-4 rounded-xl border border-sky-900/50 bg-zinc-900/60 px-3 py-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-bold text-sky-200">ระยะต้น (หลักฐานซ่อนก่อน → ราคาเป็นแค่จังหวะ)</h2>
        <span className="text-[11px] text-zinc-500">
          อัปเดต {data?.updatedAt ? ago(data.updatedAt) : "—"}
          {rules ? ` · เกณฑ์: เฝ้าดู ≥${rules.watchMinFactors} ข้อ (ต้องมี OI สะสม) · ระยะต้น ≥${rules.ignitionMinFactors} ข้อ + trigger ราคา` : ""}
        </span>
      </div>
      {error && <div className="mb-2 rounded border border-amber-800/60 bg-amber-950/40 px-2 py-1 text-xs text-amber-200">ดึงข้อมูลไม่ได้: {error}</div>}
      <div className="flex flex-col gap-4 md:flex-row">
        <Group
          title="เฝ้าดู: กำลังสะสม / กำลังแจกของ"
          hint="OI สะสมขณะราคานิ่ง + หลักฐานอื่น (funding, L/S, taker, spot) — ยังไม่ใช่จุดเข้า"
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
      <p className="mt-2 text-[11px] text-zinc-500">สัญญาณระยะต้น เสี่ยงหลอกสูงกว่า ไม่ใช่คำแนะนำการลงทุน</p>
    </section>
  );
}
