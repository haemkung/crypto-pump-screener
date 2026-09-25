"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ScreenMode, ScreenResponse, ScreenRow } from "@/lib/types";
import {
  fmtBangkok,
  fmtFunding,
  fmtPct,
  fmtPrice,
  fmtRatio,
  fmtVol,
  flagLabelTh,
} from "@/lib/format";
import { DetailPanel } from "./DetailPanel";
import { FeedbackButtons } from "./FeedbackButtons";
import { LearningStatsPanel } from "./LearningStatsPanel";
import { CoachNotesPanel } from "./CoachNotesPanel";
import { EarlyTiersPanel } from "./EarlyTiersPanel";
import { qualityBadgeClass, regimeChipClass } from "@/lib/format";
import { apiUrl } from "@/lib/apiBase";

const REFRESH_MS = 50_000;
const DEFAULT_PAGE_SIZE = 80;
const PAGE_SIZE_OPTIONS = [50, 80, 100, 200] as const;
const LOAD_MORE_STEP = 50;
const OI_TOP_DEFAULT = 40;
const LS_SCREEN_KEY = "cps-screen-last-good-v1";

function readScreenLastGood(): ScreenResponse | null {
  try {
    const s = localStorage.getItem(LS_SCREEN_KEY);
    if (!s) return null;
    const j = JSON.parse(s) as ScreenResponse;
    if (!j || !Array.isArray(j.rows) || j.rows.length < 1) return null;
    return j;
  } catch {
    return null;
  }
}

function writeScreenLastGood(json: ScreenResponse): void {
  try {
    if (!json?.rows || json.rows.length < 1) return;
    localStorage.setItem(LS_SCREEN_KEY, JSON.stringify(json));
  } catch {
    // quota / private mode
  }
}

export function Screener() {
  const [data, setData] = useState<ScreenResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [oiLoading, setOiLoading] = useState(false);
  const [mode, setMode] = useState<ScreenMode>("long");
  const [minVol, setMinVol] = useState(1_000_000);
  const [minScore, setMinScore] = useState(20);
  const [hideLate, setHideLate] = useState(true);
  const [selected, setSelected] = useState<ScreenRow | null>(null);
  const [lastFetchLocal, setLastFetchLocal] = useState<string>("—");
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [feedbackRefresh, setFeedbackRefresh] = useState(0);
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

  const enrichOi = useCallback(
    async (force = false) => {
      const gen = ++oiEnrichGen.current;
      setOiLoading(true);
      try {
        const params = new URLSearchParams({
          oiTop: String(OI_TOP_DEFAULT),
        });
        if (force) params.set("refresh", "1");
        const res = await fetch(apiUrl(`/api/screen?${params}`));
        if (!res.ok) return;
        const json = (await res.json()) as ScreenResponse;
        if (gen !== oiEnrichGen.current) return;
        applyResponse(json);
        writeScreenLastGood(json);
      } catch {
        // keep fast-path data
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
        if (isInitial && !background) {
          setLoading(true);
        } else {
          setRefreshing(true);
        }

        const params = new URLSearchParams();
        const useFastPath = isInitial || force;
        params.set("oiTop", useFastPath ? "0" : String(OI_TOP_DEFAULT));
        if (force) params.set("refresh", "1");

        const res = await fetch(apiUrl(`/api/screen?${params}`), {
          cache: "no-store",
        });
        const json = (await res.json().catch(() => null)) as
          | (ScreenResponse & {
              meta?: { softFail?: boolean; reason?: string };
              error?: string;
            })
          | null;
        const softEmpty =
          !!json?.meta?.softFail &&
          (!Array.isArray(json.rows) || json.rows.length === 0);
        if (!res.ok || !json || softEmpty) {
          throw new Error(
            json?.error ||
              json?.meta?.reason ||
              `HTTP ${res.status}`
          );
        }
        if (!Array.isArray(json.rows) || json.rows.length === 0) {
          throw new Error("empty screen rows");
        }

        applyResponse(json);
        writeScreenLastGood(json);
        setStale(res.headers.get("X-Screen-Stale") === "1");
        setError(null);

        if (useFastPath) {
          void enrichOi(force);
        }
      } catch (e) {
        const msg = String(e instanceof Error ? e.message : e);
        setError(msg);
        setStale(true);
        if (!hasDataRef.current) {
          const cached = readScreenLastGood();
          if (cached) applyResponse(cached);
        }
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

  // Reset page size when switching mode so pagination feels fresh
  useEffect(() => {
    setPageSize(DEFAULT_PAGE_SIZE);
  }, [mode]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const rows = data.rows.filter((r) => {
      if (r.quoteVolume < minVol) return false;
      if (mode === "long") {
        if (r.score < minScore) return false;
        if (hideLate && r.flags.includes("late_chase")) return false;
      } else {
        if (r.shortScore < minScore) return false;
        if (hideLate && r.shortFlags.includes("late_short_chase")) return false;
      }
      return true;
    });

    const sorted = [...rows];
    if (mode === "short") {
      sorted.sort((a, b) => b.shortScore - a.shortScore);
    } else {
      sorted.sort((a, b) => b.score - a.score);
    }
    return sorted;
  }, [data, minVol, minScore, hideLate, mode]);

  const visible = useMemo(
    () => filtered.slice(0, pageSize),
    [filtered, pageSize]
  );
  const hasMore = filtered.length > pageSize;
  const isShort = mode === "short";

  return (
    <div className="mx-auto min-h-[100dvh] max-w-[1600px] bg-[#09090b] px-4 py-6 text-[#fafafa]">
      <header className="mb-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="mb-1 text-xs uppercase tracking-widest text-emerald-500/80">
              Binance USDⓈ-M Futures
            </p>
            <h1 className="text-2xl font-bold text-white sm:text-3xl">
              Crypto Pump / Dump Pattern Screener
            </h1>
            <p className="mt-1 text-sm text-zinc-400">
              สแกนรูปแบบ Long (ขาขึ้น) และ Short (ขาลง) แยกคะแนน — heuristic จากข้อมูลสาธารณะ
            </p>
            {data?.meta?.regime?.kind && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1 ${regimeChipClass(
                    data.meta.regime.kind
                  )}`}
                >
                  Regime: {data.meta.regime.labelTh ?? data.meta.regime.kind}
                </span>
                <span className="font-mono text-[10px] text-zinc-500">
                  BTC {fmtPct(data.meta.regime.btc24h)} · ETH{" "}
                  {fmtPct(data.meta.regime.eth24h)}
                </span>
              </div>
            )}
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
          {isShort && (
            <span className="mt-1 block text-rose-200/90">
              โหมด Short: ราคาขาลงอาจเด้งแรง / long squeeze ได้ — คะแนนเป็น heuristic
              ไม่ใช่คำสั่งเทรด
            </span>
          )}
        </div>

        {/* Early tiers (confluence-first) — หลักฐานซ่อนก่อน → ราคาเป็นแค่จังหวะ */}
        <EarlyTiersPanel />

        {/* Optional panels — failures should not blank the page */}
        <div className="contents">
          <LearningStatsPanel refreshKey={feedbackRefresh} />
          <CoachNotesPanel refreshKey={feedbackRefresh} />
        </div>

        {/* Mode tabs */}
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => setMode("long")}
            className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
              mode === "long"
                ? "bg-emerald-600 text-white shadow-lg shadow-emerald-900/40"
                : "border border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-zinc-200"
            }`}
          >
            Long (ขาขึ้น)
          </button>
          <button
            type="button"
            onClick={() => setMode("short")}
            className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
              mode === "short"
                ? "bg-rose-600 text-white shadow-lg shadow-rose-900/40"
                : "border border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-zinc-200"
            }`}
          >
            Short (ขาลง)
          </button>
        </div>
      </header>

      <section className="mb-4 flex flex-wrap items-end gap-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
        <label htmlFor="min-vol" className="flex flex-col gap-1 text-xs text-zinc-400">
          Vol ขั้นต่ำ (USDT)
          <input
            id="min-vol"
            name="minVol"
            type="number"
            className="w-40 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-sm text-white"
            value={minVol}
            onChange={(e) => setMinVol(Number(e.target.value) || 0)}
            min={0}
            step={100000}
          />
        </label>
        <label htmlFor="min-score" className="flex flex-col gap-1 text-xs text-zinc-400">
          {isShort ? "Short Score ขั้นต่ำ" : "Score ขั้นต่ำ"}
          <input
            id="min-score"
            name="minScore"
            type="number"
            className="w-28 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-sm text-white"
            value={minScore}
            onChange={(e) => setMinScore(Number(e.target.value) || 0)}
            min={0}
            max={100}
          />
        </label>
        <div className="flex max-w-md flex-col gap-1">
          <label htmlFor="hide-late" className="flex items-center gap-2 text-sm text-zinc-300">
            <input
              id="hide-late"
              name="hideLate"
              type="checkbox"
              checked={hideLate}
              onChange={(e) => setHideLate(e.target.checked)}
              className="size-4 accent-emerald-500"
            />
            {isShort
              ? "ซ่อน Late Short (ลงลึก / chase)"
              : "ซ่อน Late/Chase (>50% 24h)"}
          </label>
          <p className="pl-6 text-[10px] leading-snug text-zinc-500">
            {isShort
              ? "เหรียญที่ลงลึกแล้วจะถูกซ่อนโดยตั้งใจ — ดูสัญญาณต้นที่แผงระยะต้นด้านบน"
              : "เช่น BR ที่ +192% จะหายจากตารางหลัง >50% โดยตั้งใจ (ไม่ไล่ราคา) — จับตอนต้นที่แผงระยะต้นด้านบน"}
          </p>
        </div>
        <label htmlFor="page-size" className="flex flex-col gap-1 text-xs text-zinc-400">
          แสดงต่อหน้า
          <select
            id="page-size"
            name="pageSize"
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
              · Fut {data.meta?.futuresPairs ?? "—"} · Spot match{" "}
              {data.meta?.spotMatched ?? "—"} · OI {data.meta?.oiEnriched ?? "—"} ·
              MTF {data.meta?.mtfEnriched ?? 0}
            </span>
          )}
        </div>
      </section>

      {loading && !data && (
        <div className="mb-4 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-8 text-center">
          <p className="text-lg font-semibold text-white">กำลังโหลด…</p>
          <p className="mt-2 text-sm text-zinc-400">
            กำลังดึงข้อมูลจาก Binance — กรุณารอสักครู่
          </p>
        </div>
      )}


      {stale && data && (
        <div className="mb-4 rounded-lg border border-amber-800/60 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
          ข้อมูลค้าง — แสดงผลล่าสุดที่มีในเครื่อง/แคช
          {error ? <span className="ml-2 font-mono text-xs text-amber-300/80">({error})</span> : null}
          <button
            type="button"
            onClick={() => {
              void load({ force: true, background: true });
            }}
            className="ml-3 rounded bg-amber-800/80 px-2 py-0.5 text-xs font-semibold text-amber-50 hover:bg-amber-700"
          >
            ลองใหม่
          </button>
        </div>
      )}

      {error && !data && (
        <div className="mb-4 rounded-xl border-2 border-rose-600 bg-rose-950/80 px-4 py-8 text-center shadow-lg shadow-rose-900/40">
          <p className="text-xl font-bold text-rose-200">โหลดข้อมูลไม่สำเร็จ</p>
          <p className="mt-2 text-sm text-rose-100/90">
            ไม่สามารถติดต่อเซิร์ฟเวอร์หรือ Binance ได้ — ตรวจสอบเน็ตแล้วกดลองใหม่
          </p>
          <p className="mt-3 break-words font-mono text-xs text-rose-300/80">
            {error}
          </p>
          <button
            type="button"
            onClick={() => {
              void load({ force: true, background: false });
            }}
            className="mt-5 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500"
          >
            ลองใหม่
          </button>
        </div>
      )}

      {error && data && (
        <div className="mb-4 rounded-lg border border-rose-900 bg-rose-950/50 px-3 py-2 text-sm text-rose-300">
          อัปเดตล่าสุดล้มเหลว: {error}
          <button
            type="button"
            onClick={() => {
              void load({ force: true, background: true });
            }}
            className="ml-3 underline hover:text-rose-100"
          >
            ลองใหม่
          </button>
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
                {!isShort && <th className="px-3 py-2">Fut/Spot</th>}
                <th className="px-3 py-2">
                  {isShort ? "Short Score" : "Score"}
                </th>
                <th className="px-3 py-2">เกรด</th>
                <th className="px-3 py-2">Flags</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r, idx) => {
                const active = selected?.symbol === r.symbol;
                const score = isShort ? r.shortScore : r.score;
                const flagsRaw = isShort ? r.shortFlags : r.flags;
                const flags = Array.isArray(flagsRaw) ? flagsRaw : [];
                const grade =
                  (isShort ? r.shortQualityGrade : r.qualityGrade) ?? "C";
                const fundingHot = isShort
                  ? r.lastFundingRate != null && r.lastFundingRate > 0
                  : r.lastFundingRate != null && r.lastFundingRate < 0;

                return (
                  <tr
                    key={r.symbol}
                    onClick={() => setSelected(r)}
                    className={`cursor-pointer border-t border-zinc-900 transition-colors hover:bg-zinc-900/80 ${
                      active
                        ? isShort
                          ? "bg-rose-950/40"
                          : "bg-emerald-950/40"
                        : ""
                    }`}
                  >
                    <td className="px-3 py-2 font-mono text-[11px] text-zinc-600">
                      {idx + 1}
                    </td>
                    <td className="px-3 py-2 font-semibold text-white">
                      <span className="inline-flex items-center gap-1.5">
                        {r.baseAsset}
                        {r.mtfAlign != null && r.mtfAlign === "mtf_align" && (
                          <span className="rounded bg-emerald-950 px-1 py-0.5 text-[8px] text-emerald-400">
                            MTF✓
                          </span>
                        )}
                        {r.falsePatternRisk && (
                          <span className="rounded bg-rose-950 px-1 py-0.5 text-[8px] text-rose-400">
                            FP
                          </span>
                        )}
                      </span>
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
                        fundingHot ? "text-emerald-400" : "text-zinc-400"
                      }`}
                    >
                      {fmtFunding(r.lastFundingRate)}
                    </td>
                    {!isShort && (
                      <td className="px-3 py-2 font-mono text-zinc-300">
                        {r.hasSpot ? (
                          fmtRatio(r.futSpotRatio)
                        ) : (
                          <span className="text-amber-500/90">No Spot</span>
                        )}
                      </td>
                    )}
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex min-w-[2.5rem] justify-center rounded-md bg-zinc-900 px-2 py-0.5 font-mono font-bold ring-1 ring-zinc-700 ${
                          isShort ? "text-rose-300" : "text-amber-300"
                        }`}
                      >
                        {score}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-black ${qualityBadgeClass(
                          grade
                        )}`}
                      >
                        {grade}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex max-w-[220px] flex-wrap gap-1">
                        {flags.slice(0, 4).map((f) => (
                          <span
                            key={f}
                            className="rounded bg-zinc-800 px-1 py-0.5 text-[10px] text-zinc-400"
                          >
                            {flagLabelTh(f)}
                          </span>
                        ))}
                        {flags.length > 4 && (
                          <span className="text-[10px] text-zinc-600">
                            +{flags.length - 4}
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
                    colSpan={isShort ? 9 : 10}
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
          <DetailPanel
            row={selected}
            mode={mode}
            onClose={() => setSelected(null)}
            onFeedback={() => setFeedbackRefresh((n) => n + 1)}
          />
        )}
      </div>

      <footer className="mt-8 border-t border-zinc-900 pt-4 text-center text-[11px] text-zinc-600">
        PatternScore / ShortScore เป็น heuristic · ไม่ invent ตัวเลขที่ API ไม่ให้ · ตารางแสดง
        Top N ตามคะแนนโหมดที่เลือก (ค่าเริ่มต้น {DEFAULT_PAGE_SIZE}) · OI hist เติมพื้นหลังหลัง
        first paint · ข้อมูลจาก Binance public API
      </footer>
    </div>
  );
}
