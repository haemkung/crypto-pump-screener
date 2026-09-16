"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ScreenResponse, ScreenRow } from "@/lib/types";
import {
  fmtBangkok,
  fmtFunding,
  fmtPct,
  fmtPrice,
  fmtRatio,
  fmtVol,
  flagLabelTh,
  entryModeBadgeClass,
} from "@/lib/format";
import { DetailPanel } from "./DetailPanel";
import { ExampleCases } from "./ExampleCases";

const REFRESH_MS = 50_000;
const DEFAULT_PAGE_SIZE = 80;
const PAGE_SIZE_OPTIONS = [50, 80, 100, 200] as const;
const LOAD_MORE_STEP = 50;
const OI_TOP_DEFAULT = 40;

export function Screener() {
  const [data, setData] = useState<ScreenResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [oiLoading, setOiLoading] = useState(false);
  const [minVol, setMinVol] = useState(1_000_000);
  const [minScore, setMinScore] = useState(20);
  const [hideLate, setHideLate] = useState(true);
  const [selected, setSelected] = useState<ScreenRow | null>(null);
  const [lastFetchLocal, setLastFetchLocal] = useState<string>("—");
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const hasDataRef = useRef(false);
  const oiEnrichGen = useRef(0);

  const applyResponse = useCallback((json: ScreenResponse) => {
    hasDataRef.current = true;
    setData(json);
    setLastFetchLocal(fmtBangkok(json.updatedAt));
    setSelected((prev) => {
      if (!prev) return null;
      return json.rows.find((r) => r.symbol === prev.symbol) || prev;
    });
  }, []);

  /** Background OI enrich — never toggles main loading. */
  const enrichOi = useCallback(
    async (force = false) => {
      const gen = ++oiEnrichGen.current;
      setOiLoading(true);
      try {
        const params = new URLSearchParams({
          oiTop: String(OI_TOP_DEFAULT),
        });
        if (force) params.set("refresh", "1");
        const res = await fetch(`/api/screen?${params}`);
        if (!res.ok) return;
        const json = (await res.json()) as ScreenResponse;
        if (gen !== oiEnrichGen.current) return;
        applyResponse(json);
      } catch {
        // keep fast-path data; detail panel still loads OI per symbol
      } finally {
        if (gen === oiEnrichGen.current) setOiLoading(false);
      }
    },
    [applyResponse]
  );

  const load = useCallback(
    async (opts?: { force?: boolean; background?: boolean }) => {
      const force = opts?.force ?? false;
      const background = opts?.background ?? false;
      const isInitial = !hasDataRef.current;
      try {
        setError(null);
        // Stale-while-revalidate: never blank the table once we have rows
        if (isInitial && !background) {
          setLoading(true);
        } else {
          setRefreshing(true);
        }

        const params = new URLSearchParams();
        // Initial + forced refresh: fast path (no OI) for snappy paint.
        // Periodic SWR: keep OI via warm oiTop cache to avoid score flicker.
        const useFastPath = isInitial || force;
        params.set("oiTop", useFastPath ? "0" : String(OI_TOP_DEFAULT));
        if (force) params.set("refresh", "1");

        const res = await fetch(`/api/screen?${params}`);
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(
            (j as { error?: string }).error || `HTTP ${res.status}`
          );
        }
        const json = (await res.json()) as ScreenResponse;
        applyResponse(json);

        // Lazy OI enrich after first paint / forced refresh (does not block UI)
        if (useFastPath) {
          void enrichOi(force);
        }
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [applyResponse, enrichOi]
  );

  useEffect(() => {
    void load({ force: false, background: false });
    const id = setInterval(() => {
      void load({ force: false, background: true });
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.rows.filter((r) => {
      if (r.quoteVolume < minVol) return false;
      if (r.score < minScore) return false;
      if (hideLate && r.flags.includes("late_chase")) return false;
      return true;
    });
  }, [data, minVol, minScore, hideLate]);

  const visible = useMemo(
    () => filtered.slice(0, pageSize),
    [filtered, pageSize]
  );
  const hasMore = filtered.length > pageSize;

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-6">
      <header className="mb-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="mb-1 text-xs uppercase tracking-widest text-emerald-500/80">
              Binance USDⓈ-M Futures
            </p>
            <h1 className="text-2xl font-bold text-white sm:text-3xl">
              Crypto Pump Pattern Screener
            </h1>
            <p className="mt-1 text-sm text-zinc-400">
              สแกนรูปแบบ 4 ขา: Catalyst (static) · Volume/OI · Short squeeze · Thin liquidity
            </p>
          </div>
          <div className="text-right text-xs text-zinc-500">
            <div>
              อัปเดตล่าสุด:{" "}
              <span className="text-zinc-300">{lastFetchLocal}</span>
              {refreshing && (
                <span className="ml-2 text-emerald-500/80">กำลังอัปเดต…</span>
              )}
              {oiLoading && (
                <span className="ml-2 text-amber-500/80">กำลังเติม OI…</span>
              )}
            </div>
            <div>รีเฟรชอัตโนมัติ ~{REFRESH_MS / 1000}s · cache เซิร์ฟเวอร์ ~45s</div>
            <button
              type="button"
              onClick={() => {
                void load({ force: true, background: hasDataRef.current });
              }}
              className="mt-2 rounded-lg border border-emerald-800 bg-emerald-950/50 px-3 py-1 text-emerald-300 hover:bg-emerald-900/60"
            >
              รีเฟรชทันที
            </button>
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-amber-900/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-200/90">
          <strong>คำเตือน / Disclaimer:</strong> ไม่ใช่คำแนะนำการลงทุนหรือการเงิน
          (Not financial advice). คะแนนเป็น heuristic จากข้อมูลสาธารณะของ Binance เท่านั้น
          อาจผิดพลาด / ล่าช้า — ใช้ศึกษาและคัดกรองเบื้องต้นเท่านั้น ความเสี่ยงสูง
        </div>
      </header>

      <ExampleCases />

      <section className="mb-4 flex flex-wrap items-end gap-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Vol ขั้นต่ำ (USDT)
          <input
            type="number"
            className="w-40 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-sm text-white"
            value={minVol}
            onChange={(e) => setMinVol(Number(e.target.value) || 0)}
            min={0}
            step={100000}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Score ขั้นต่ำ
          <input
            type="number"
            className="w-28 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-sm text-white"
            value={minScore}
            onChange={(e) => setMinScore(Number(e.target.value) || 0)}
            min={0}
            max={100}
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={hideLate}
            onChange={(e) => setHideLate(e.target.checked)}
            className="size-4 accent-emerald-500"
          />
          ซ่อน Late/Chase (&gt;50% 24h)
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          แสดงต่อหน้า
          <select
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-sm text-white"
            value={
              PAGE_SIZE_OPTIONS.includes(
                pageSize as (typeof PAGE_SIZE_OPTIONS)[number]
              )
                ? pageSize
                : "custom"
            }
            onChange={(e) => {
              const v = e.target.value;
              if (v === "custom") return;
              setPageSize(Number(v));
            }}
          >
            {PAGE_SIZE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n} แถว
              </option>
            ))}
            {!PAGE_SIZE_OPTIONS.includes(
              pageSize as (typeof PAGE_SIZE_OPTIONS)[number]
            ) && <option value="custom">{pageSize} แถว</option>}
          </select>
        </label>
        <div className="ml-auto text-xs text-zinc-500">
          {loading && !data
            ? "กำลังโหลด…"
            : `แสดง ${visible.length} / ${filtered.length} ที่กรอง (ทั้งหมด ${data?.rows.length ?? 0} คู่)`}
          {data && (
            <span className="ml-2">
              · Fut {data.meta.futuresPairs} · Spot match {data.meta.spotMatched} ·
              OI {data.meta.oiEnriched}
            </span>
          )}
        </div>
      </section>

      {error && (
        <div className="mb-4 rounded-lg border border-rose-900 bg-rose-950/50 px-3 py-2 text-sm text-rose-300">
          โหลดไม่สำเร็จ: {error}
        </div>
      )}

      <div className={`grid gap-4 ${selected ? "lg:grid-cols-[1fr_340px]" : ""}`}>
        <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950/80">
          <table className="w-full min-w-[1000px] border-collapse text-left text-sm">
            <thead className="sticky top-0 bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-3 py-2">#</th>
                <th className="px-3 py-2">Symbol</th>
                <th className="px-3 py-2">ราคา</th>
                <th className="px-3 py-2">24h%</th>
                <th className="px-3 py-2">Vol</th>
                <th className="px-3 py-2">Funding</th>
                <th className="px-3 py-2">Fut/Spot</th>
                <th className="px-3 py-2">Score</th>
                <th className="px-3 py-2">จุดเข้า</th>
                <th className="px-3 py-2">Flags</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r, idx) => {
                const active = selected?.symbol === r.symbol;
                return (
                  <tr
                    key={r.symbol}
                    onClick={() => setSelected(r)}
                    className={`cursor-pointer border-t border-zinc-900 transition-colors hover:bg-zinc-900/80 ${
                      active ? "bg-emerald-950/40" : ""
                    }`}
                  >
                    <td className="px-3 py-2 font-mono text-[11px] text-zinc-600">
                      {idx + 1}
                    </td>
                    <td className="px-3 py-2 font-semibold text-white">
                      {r.baseAsset}
                      <span className="ml-1 font-mono text-[10px] text-zinc-600">
                        USDT
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-zinc-200">
                      {fmtPrice(r.price)}
                    </td>
                    <td
                      className={`px-3 py-2 font-mono ${
                        r.priceChangePercent >= 0
                          ? "text-emerald-400"
                          : "text-rose-400"
                      }`}
                    >
                      {fmtPct(r.priceChangePercent)}
                    </td>
                    <td className="px-3 py-2 font-mono text-zinc-300">
                      {fmtVol(r.quoteVolume)}
                    </td>
                    <td
                      className={`px-3 py-2 font-mono ${
                        r.lastFundingRate != null && r.lastFundingRate < 0
                          ? "text-emerald-400"
                          : "text-zinc-400"
                      }`}
                    >
                      {fmtFunding(r.lastFundingRate)}
                    </td>
                    <td className="px-3 py-2 font-mono text-zinc-300">
                      {r.hasSpot ? (
                        fmtRatio(r.futSpotRatio)
                      ) : (
                        <span className="text-amber-500/90">No Spot</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span className="inline-flex min-w-[2.5rem] justify-center rounded-md bg-zinc-900 px-2 py-0.5 font-mono font-bold text-amber-300 ring-1 ring-zinc-700">
                        {r.score}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {r.entry ? (
                        <div className="flex flex-col gap-0.5">
                          <span
                            className={`inline-flex w-fit rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ${entryModeBadgeClass(r.entry.mode)}`}
                          >
                            {r.entry.labelTh}
                          </span>
                          {r.entry.entryLow != null &&
                          r.entry.entryHigh != null ? (
                            <span className="font-mono text-[10px] text-zinc-500">
                              {fmtPrice(r.entry.entryLow)}–
                              {fmtPrice(r.entry.entryHigh)}
                            </span>
                          ) : r.entry.mode === "too_late" ? (
                            <span className="text-[10px] text-rose-500/80">
                              ไม่แนะนำไล่
                            </span>
                          ) : (
                            <span className="text-[10px] text-zinc-600">—</span>
                          )}
                        </div>
                      ) : (
                        <span className="text-[10px] text-zinc-600">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex max-w-[220px] flex-wrap gap-1">
                        {r.flags.slice(0, 4).map((f) => (
                          <span
                            key={f}
                            className="rounded bg-zinc-800 px-1 py-0.5 text-[10px] text-zinc-400"
                          >
                            {flagLabelTh(f)}
                          </span>
                        ))}
                        {r.flags.length > 4 && (
                          <span className="text-[10px] text-zinc-600">
                            +{r.flags.length - 4}
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={10}
                    className="px-3 py-8 text-center text-zinc-500"
                  >
                    ไม่มีแถวที่ตรงเงื่อนไข — ลองลด min volume / score
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {hasMore && (
            <div className="flex items-center justify-center gap-3 border-t border-zinc-900 px-3 py-3">
              <button
                type="button"
                onClick={() =>
                  setPageSize((n) =>
                    Math.min(n + LOAD_MORE_STEP, filtered.length)
                  )
                }
                className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-800"
              >
                โหลดเพิ่ม (+{LOAD_MORE_STEP}) — เหลือ{" "}
                {filtered.length - pageSize} แถว
              </button>
              <button
                type="button"
                onClick={() => setPageSize(filtered.length)}
                className="rounded-lg border border-zinc-800 px-3 py-2 text-xs text-zinc-500 hover:text-zinc-300"
              >
                แสดงทั้งหมด
              </button>
            </div>
          )}
        </div>

        {selected && (
          <DetailPanel row={selected} onClose={() => setSelected(null)} />
        )}
      </div>

      <footer className="mt-8 border-t border-zinc-900 pt-4 text-center text-[11px] text-zinc-600">
        PatternScore เป็น heuristic · ไม่ invent ตัวเลขที่ API ไม่ให้ · ตารางแสดง Top N
        ตามคะแนน (ค่าเริ่มต้น {DEFAULT_PAGE_SIZE}) · OI hist เติมพื้นหลังหลัง first paint ·
        ข้อมูลจาก Binance public API
      </footer>
    </div>
  );
}
