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
  entryModeBadgeClass,
} from "@/lib/format";
import { DetailPanel } from "./DetailPanel";
import { ExampleCases } from "./ExampleCases";
import { FeedbackButtons } from "./FeedbackButtons";
import { LearningStatsPanel } from "./LearningStatsPanel";
import { CoachNotesPanel } from "./CoachNotesPanel";
import { HotStrip } from "./HotStrip";
import { qualityBadgeClass, regimeChipClass } from "@/lib/format";

const REFRESH_MS = 50_000;
const DEFAULT_PAGE_SIZE = 80;
const PAGE_SIZE_OPTIONS = [50, 80, 100, 200] as const;
const LOAD_MORE_STEP = 50;
const OI_TOP_DEFAULT = 40;

function isEnterNow(u: ScreenRow["urgency"]): boolean {
  return u === "now_long" || u === "now_short";
}
function isWaitSweep(u: ScreenRow["urgency"]): boolean {
  return u === "wait_sweep_long" || u === "wait_sweep_short";
}

export function Screener() {
  const [data, setData] = useState<ScreenResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [oiLoading, setOiLoading] = useState(false);
  const [mode, setMode] = useState<ScreenMode>("long");
  const [minVol, setMinVol] = useState(1_000_000);
  const [minScore, setMinScore] = useState(20);
  const [hideLate, setHideLate] = useState(true);
  const [nowOnly, setNowOnly] = useState(false);
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
        const res = await fetch(`/api/screen?${params}`);
        if (!res.ok) return;
        const json = (await res.json()) as ScreenResponse;
        if (gen !== oiEnrichGen.current) return;
        applyResponse(json);
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
        setError(null);
        if (isInitial && !background) {
          setLoading(true);
        } else {
          setRefreshing(true);
        }

        const params = new URLSearchParams();
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

  // Reset page size when switching mode so pagination feels fresh
  useEffect(() => {
    setPageSize(DEFAULT_PAGE_SIZE);
  }, [mode]);

  const nowAlerts = useMemo(() => {
    if (!data) return { long: [] as ScreenRow[], short: [] as ScreenRow[] };
    const long = data.rows
      .filter((r) => r.urgency === "now_long")
      .sort((a, b) => {
        const av = a.flags.includes("high_volume") ? 1 : 0;
        const bv = b.flags.includes("high_volume") ? 1 : 0;
        if (bv !== av) return bv - av;
        return b.score - a.score;
      });
    const short = data.rows
      .filter((r) => r.urgency === "now_short")
      .sort((a, b) => {
        const av = a.shortFlags.includes("high_volume") ? 1 : 0;
        const bv = b.shortFlags.includes("high_volume") ? 1 : 0;
        if (bv !== av) return bv - av;
        return b.shortScore - a.shortScore;
      });
    return { long, short };
  }, [data]);

  const waitAlerts = useMemo(() => {
    if (!data) return { long: [] as ScreenRow[], short: [] as ScreenRow[] };
    const long = data.rows
      .filter((r) => r.urgency === "wait_sweep_long")
      .sort((a, b) => b.score - a.score);
    const short = data.rows
      .filter((r) => r.urgency === "wait_sweep_short")
      .sort((a, b) => b.shortScore - a.shortScore);
    return { long, short };
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const rows = data.rows.filter((r) => {
      if (r.quoteVolume < minVol) return false;
      if (nowOnly) {
        if (mode === "long") return r.urgency === "now_long";
        return r.urgency === "now_short";
      }
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
    const rank = (u: ScreenRow["urgency"], side: "long" | "short") => {
      if (side === "short") {
        if (u === "now_short") return 2;
        if (u === "wait_sweep_short") return 1;
        return 0;
      }
      if (u === "now_long") return 2;
      if (u === "wait_sweep_long") return 1;
      return 0;
    };
    if (mode === "short") {
      sorted.sort((a, b) => {
        const d = rank(b.urgency, "short") - rank(a.urgency, "short");
        if (d !== 0) return d;
        return b.shortScore - a.shortScore;
      });
    } else {
      sorted.sort((a, b) => {
        const d = rank(b.urgency, "long") - rank(a.urgency, "long");
        if (d !== 0) return d;
        return b.score - a.score;
      });
    }
    return sorted;
  }, [data, minVol, minScore, hideLate, mode, nowOnly]);

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
              โหมด Short: ราคาขาลงอาจเด้งแรง / long squeeze ได้ — จุด Short เป็น heuristic
              ไม่ใช่คำสั่งเทรด
            </span>
          )}
        </div>

        {/* Hot early accel — TOP so user cannot miss BR-type names while still early */}
        <HotStrip
          screenRows={data?.rows ?? null}
          onSelect={(row) => {
            setSelected(row);
            setNowOnly(false);
          }}
          onSelectMode={setMode}
        />

        {/* Optional panels — failures should not blank the page */}
        <div className="contents">
          <LearningStatsPanel refreshKey={feedbackRefresh} />
          <CoachNotesPanel refreshKey={feedbackRefresh} />
        </div>

        {/* NOW urgency banner */}
        {(nowAlerts.long.length > 0 || nowAlerts.short.length > 0) && (
          <div className="sticky top-0 z-30 mt-4 animate-pulse rounded-xl border-2 border-orange-500/80 bg-gradient-to-r from-orange-950 via-rose-950 to-orange-950 px-4 py-3 shadow-lg shadow-orange-900/50">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="rounded bg-orange-500 px-2 py-0.5 text-xs font-black uppercase tracking-widest text-black">
                ตอนนี้ / NOW
              </span>
              <span className="text-sm font-bold text-orange-100">
                สัญญาณเข้าตอนนี้ (heuristic — ไม่ใช่คำสั่งซื้อ)
              </span>
              <span className="text-[10px] text-orange-200/70">
                Long {nowAlerts.long.length} · Short {nowAlerts.short.length}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {nowAlerts.long.slice(0, 8).map((r) => (
                <div
                  key={`nl-${r.symbol}`}
                  className="rounded-lg border border-emerald-500/50 bg-emerald-950/80 px-2.5 py-1.5 text-left"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setMode("long");
                      setSelected(r);
                      setNowOnly(false);
                    }}
                    className="w-full text-left hover:opacity-90"
                  >
                    <span className="font-bold text-emerald-300">{r.baseAsset}</span>
                    <span className="ml-2 font-mono text-xs text-emerald-400">
                      {fmtPct(r.priceChangePercent)}
                    </span>
                    <span className="ml-2 text-[10px] text-orange-200">
                      {r.urgencyLabelTh ?? "ลงมากิน SL อีกฝั่งแล้ว — เข้าตอนนี้"}
                    </span>
                    <span
                      className={`ml-1 rounded px-1 py-0.5 text-[9px] font-black ${qualityBadgeClass(
                        r.qualityGrade
                      )}`}
                    >
                      {r.qualityGrade ?? "C"}
                    </span>
                  </button>
                  <FeedbackButtons
                    compact
                    symbol={r.symbol}
                    side="long"
                    score={r.score}
                    price={r.price}
                    onDone={() => setFeedbackRefresh((n) => n + 1)}
                  />
                </div>
              ))}
              {nowAlerts.short.slice(0, 8).map((r) => (
                <div
                  key={`ns-${r.symbol}`}
                  className="rounded-lg border border-rose-500/50 bg-rose-950/80 px-2.5 py-1.5 text-left"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setMode("short");
                      setSelected(r);
                      setNowOnly(false);
                    }}
                    className="w-full text-left hover:opacity-90"
                  >
                    <span className="font-bold text-rose-300">{r.baseAsset}</span>
                    <span className="ml-2 font-mono text-xs text-rose-400">
                      {fmtPct(r.priceChangePercent)}
                    </span>
                    <span className="ml-2 text-[10px] text-orange-200">
                      {r.urgencyLabelTh ?? "ขึ้นมากิน SL อีกฝั่งแล้ว — เข้าตอนนี้"}
                    </span>
                    <span
                      className={`ml-1 rounded px-1 py-0.5 text-[9px] font-black ${qualityBadgeClass(
                        r.shortQualityGrade
                      )}`}
                    >
                      {r.shortQualityGrade ?? "C"}
                    </span>
                  </button>
                  <FeedbackButtons
                    compact
                    symbol={r.symbol}
                    side="short"
                    score={r.shortScore}
                    price={r.price}
                    onDone={() => setFeedbackRefresh((n) => n + 1)}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {(waitAlerts.long.length > 0 || waitAlerts.short.length > 0) && (
          <div className="mt-3 rounded-xl border border-amber-700/60 bg-amber-950/40 px-4 py-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="rounded bg-amber-400 px-2 py-0.5 text-xs font-black uppercase tracking-widest text-black">
                รอ
              </span>
              <span className="text-sm font-bold text-amber-100">
                รอแท่งกลับหลังทะลุ — ยังไม่เข้าตอนนี้
              </span>
              <span className="text-[10px] text-amber-200/70">
                Long {waitAlerts.long.length} · Short {waitAlerts.short.length}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {waitAlerts.long.slice(0, 10).map((r) => (
                <button
                  key={`wl-${r.symbol}`}
                  type="button"
                  onClick={() => {
                    setMode("long");
                    setSelected(r);
                    setNowOnly(false);
                  }}
                  className="rounded-lg border border-amber-700/50 bg-zinc-950/70 px-2.5 py-1.5 text-left hover:border-amber-400"
                >
                  <span className="font-bold text-amber-200">{r.baseAsset}</span>
                  <span className="ml-2 font-mono text-xs text-zinc-400">
                    {fmtPct(r.priceChangePercent)}
                  </span>
                  <span className="ml-2 text-[10px] text-amber-300">รอแท่งกลับหลังทะลุ</span>
                </button>
              ))}
              {waitAlerts.short.slice(0, 8).map((r) => (
                <button
                  key={`ws-${r.symbol}`}
                  type="button"
                  onClick={() => {
                    setMode("short");
                    setSelected(r);
                    setNowOnly(false);
                  }}
                  className="rounded-lg border border-amber-800/50 bg-zinc-950/70 px-2.5 py-1.5 text-left hover:border-amber-400"
                >
                  <span className="font-bold text-rose-200">{r.baseAsset}</span>
                  <span className="ml-2 font-mono text-xs text-zinc-400">
                    {fmtPct(r.priceChangePercent)}
                  </span>
                  <span className="ml-2 text-[10px] text-amber-300">รอแท่งกลับหลังทะลุ</span>
                </button>
              ))}
            </div>
          </div>
        )}

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

      {!isShort && <ExampleCases />}

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
              ? "เหรียญที่ลงลึกแล้วจะถูกซ่อนโดยตั้งใจ — ดูสัญญาณต้นที่แผง «กำลังเร่งตัว» ด้านบน"
              : "เช่น BR ที่ +192% จะหายจากตารางหลัง >50% โดยตั้งใจ (ไม่ไล่ราคา) — จับตอนต้นที่แผง «กำลังเร่งตัว» ด้านบน"}
          </p>
        </div>
        <label htmlFor="now-only" className="flex items-center gap-2 text-sm font-semibold text-orange-300">
          <input
            id="now-only"
            name="nowOnly"
            type="checkbox"
            checked={nowOnly}
            onChange={(e) => setNowOnly(e.target.checked)}
            className="size-4 accent-orange-500"
          />
          แสดงเฉพาะตอนนี้
        </label>
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
                <th className="px-3 py-2">
                  {isShort ? "จุด Short" : "จุดเข้า"}
                </th>
                <th className="px-3 py-2">Flags</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r, idx) => {
                const active = selected?.symbol === r.symbol;
                const score = isShort ? r.shortScore : r.score;
                const flagsRaw = isShort ? r.shortFlags : r.flags;
                const flags = Array.isArray(flagsRaw) ? flagsRaw : [];
                const entry = isShort ? r.shortEntry : r.entry;
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
                      isEnterNow(r.urgency)
                        ? "bg-orange-950/50 ring-1 ring-inset ring-orange-500/40"
                        : isWaitSweep(r.urgency)
                          ? "bg-amber-950/30 ring-1 ring-inset ring-amber-700/40"
                          : active
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
                        {isEnterNow(r.urgency) && (
                          <span className="animate-pulse rounded bg-orange-500 px-1 py-0.5 text-[9px] font-black uppercase tracking-wide text-black">
                            เข้า
                          </span>
                        )}
                        {isWaitSweep(r.urgency) && (
                          <span className="rounded bg-amber-400 px-1 py-0.5 text-[9px] font-black uppercase tracking-wide text-black">
                            รอ
                          </span>
                        )}
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
                      {entry ? (
                        <div className="flex flex-col gap-0.5">
                          <span
                            className={`inline-flex w-fit rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ${entryModeBadgeClass(entry.mode)}`}
                          >
                            {entry.labelTh}
                          </span>
                          {r.urgencyLabelTh &&
                            (isEnterNow(r.urgency) || isWaitSweep(r.urgency)) && (
                              <span
                                className={`max-w-[180px] text-[10px] leading-tight ${
                                  isEnterNow(r.urgency)
                                    ? "font-semibold text-orange-300"
                                    : "text-amber-300"
                                }`}
                              >
                                {r.urgencyLabelTh}
                              </span>
                            )}
                          {entry.entryLow != null && entry.entryHigh != null ? (
                            <span className="font-mono text-[10px] text-zinc-500">
                              {fmtPrice(entry.entryLow)}–
                              {fmtPrice(entry.entryHigh)}
                            </span>
                          ) : entry.mode === "too_late" ||
                            entry.mode === "too_late_short" ? (
                            <span className="text-[10px] text-rose-500/80">
                              {isShort ? "ไม่ไล่ Short" : "ไม่แนะนำไล่"}
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
                    colSpan={isShort ? 10 : 11}
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
