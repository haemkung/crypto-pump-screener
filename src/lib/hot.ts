/**
 * Early acceleration scanner — catch BR-type rockets while still early.
 *
 * Scans ALL USDT-M perps (vol floor only). Does NOT require pattern score,
 * funding, or grade A — those filters previously buried early movers.
 * Heavy kline work runs on bot upstream (local Next), not Workers CPU.
 */

import {
  getFuturesTickers,
  getKlines,
  sleep,
  baseFromSymbol,
  isUsdtPerpetual,
} from "./binance";
import { cacheGet, cacheSet } from "./cache";
import type { EntryMode, Flag, HotResponse, HotRow, QualityGrade } from "./types";

const HOT_TTL = 35_000;
/** Still catchable — not late chase */
const LATE_24H = 50;
/** Soft early band for ranking / labeling */
const EARLY_24H_MAX = 35;
const MIN_VOL = 300_000;
/** Max symbols to fetch 5m klines for (Workers-safe via upstream) */
const KLINE_MAX = 60;
const KLINE_CONCURRENCY = 10;
/** Appear in panel if 1h accel clears this (primary gate) */
const MIN_PCT_1H = 2.5;
/** Or 15m surge (from same 5m bars) */
const MIN_PCT_15M = 2.0;
/** Also include early-band 24h if 1h at least mild */
const MILD_PCT_1H = 1.0;
const PANEL_CAP = 60;
const LATE_LIMIT = 12;

export interface AccelMetrics {
  pct1h: number | null;
  pct15m: number | null;
  pct5m: number | null;
}

/** Derive 5m / ~15m / ~1h % from one 5m kline fetch (limit 13). */
export function metricsFrom5mBars(
  bars: { close: number }[]
): AccelMetrics {
  if (!bars || bars.length < 2) {
    return { pct1h: null, pct15m: null, pct5m: null };
  }
  const last = bars[bars.length - 1].close;
  if (!Number.isFinite(last) || last <= 0) {
    return { pct1h: null, pct15m: null, pct5m: null };
  }
  const pct = (fromIdx: number): number | null => {
    const i = Math.max(0, bars.length - 1 - fromIdx);
    const older = bars[i].close;
    if (!Number.isFinite(older) || older <= 0) return null;
    return ((last - older) / older) * 100;
  };
  return {
    pct5m: pct(1),
    pct15m: pct(3),
    pct1h: pct(Math.min(12, bars.length - 1)),
  };
}

export async function batchAccelMetrics(
  symbols: string[],
  concurrency = KLINE_CONCURRENCY
): Promise<Map<string, AccelMetrics>> {
  const out = new Map<string, AccelMetrics>();
  for (let i = 0; i < symbols.length; i += concurrency) {
    const chunk = symbols.slice(i, i + concurrency);
    await Promise.all(
      chunk.map(async (sym) => {
        try {
          const bars = await getKlines(sym, "5m", 13);
          out.set(sym, metricsFrom5mBars(bars));
        } catch {
          out.set(sym, { pct1h: null, pct15m: null, pct5m: null });
        }
      })
    );
    if (i + concurrency < symbols.length) await sleep(40);
  }
  return out;
}

function accelStrength(m: AccelMetrics, pct24h: number): number {
  const p1 = m.pct1h ?? 0;
  const p15 = m.pct15m ?? 0;
  const p5 = m.pct5m ?? 0;
  // Weight recent surge highest; slight penalty as 24h approaches late
  const latePen = pct24h > 35 ? (pct24h - 35) * 0.15 : 0;
  return p1 * 3 + p15 * 1.5 + p5 * 0.75 - latePen;
}

function isAccelerating(
  m: AccelMetrics,
  pct24h: number
): boolean {
  if (pct24h >= LATE_24H) return false; // too late for "catch early" panel
  const p1 = m.pct1h;
  const p15 = m.pct15m;
  if (p1 != null && p1 >= MIN_PCT_1H) return true;
  if (p15 != null && p15 >= MIN_PCT_15M && pct24h < EARLY_24H_MAX) return true;
  // Early-band 24h + mild 1h (ignition already underway)
  if (
    pct24h >= 5 &&
    pct24h <= EARLY_24H_MAX &&
    p1 != null &&
    p1 >= MILD_PCT_1H
  ) {
    return true;
  }
  return false;
}

function toHotRow(
  symbol: string,
  price: number,
  pct24h: number,
  quoteVolume: number,
  m: AccelMetrics,
  early: boolean
): HotRow {
  return {
    symbol,
    baseAsset: baseFromSymbol(symbol),
    price,
    pct1h: m.pct1h,
    pct15m: m.pct15m,
    pct24h,
    score: 0, // intentionally unused for this panel
    quoteVolume,
    flags: (early ? (["early_move"] as Flag[]) : (["late_chase"] as Flag[])),
    entryMode: (early ? "early_entry" : "too_late") as EntryMode,
    qualityGrade: "C" as QualityGrade,
    early,
  };
}

export async function buildHot(options?: {
  forceRefresh?: boolean;
}): Promise<HotResponse> {
  const cacheKey = "hot:v2:all-perps";
  if (!options?.forceRefresh) {
    const hit = cacheGet<HotResponse>(cacheKey);
    if (hit) return hit;
  }

  const warnings: string[] = [];
  const tickers = await getFuturesTickers();
  const perps = tickers.filter((t) => isUsdtPerpetual(t.symbol));

  type Cand = {
    symbol: string;
    price: number;
    pct24h: number;
    quoteVolume: number;
  };

  const liquid: Cand[] = perps
    .map((t) => ({
      symbol: t.symbol,
      price: Number(t.lastPrice) || 0,
      pct24h: Number(t.priceChangePercent) || 0,
      quoteVolume: Number(t.quoteVolume) || 0,
    }))
    .filter((c) => c.quoteVolume >= MIN_VOL && c.price > 0);

  // Priority for kline scan: anything not-yet-late that could be accelerating.
  // Sort by 24h desc within rising band so we enrich the most active first,
  // then fill remaining slots with high-vol mild movers (ignition).
  const rising = liquid
    .filter((c) => c.pct24h >= 2 && c.pct24h < LATE_24H)
    .sort((a, b) => b.pct24h - a.pct24h);

  const ignition = liquid
    .filter((c) => c.pct24h >= 0 && c.pct24h < 8)
    .sort((a, b) => b.quoteVolume - a.quoteVolume);

  const seen = new Set<string>();
  const klineTargets: string[] = [];
  for (const c of [...rising, ...ignition]) {
    if (seen.has(c.symbol)) continue;
    seen.add(c.symbol);
    klineTargets.push(c.symbol);
    if (klineTargets.length >= KLINE_MAX) break;
  }

  let metricsMap = new Map<string, AccelMetrics>();
  let enriched1h = 0;
  try {
    metricsMap = await batchAccelMetrics(klineTargets);
    enriched1h = [...metricsMap.values()].filter((m) => m.pct1h != null).length;
  } catch (e) {
    warnings.push(`accel kline batch failed: ${String(e)}`);
  }

  const bySym = new Map(liquid.map((c) => [c.symbol, c]));
  const hot: HotRow[] = [];
  for (const sym of klineTargets) {
    const c = bySym.get(sym);
    const m = metricsMap.get(sym);
    if (!c || !m) continue;
    if (!isAccelerating(m, c.pct24h)) continue;
    hot.push(toHotRow(sym, c.price, c.pct24h, c.quoteVolume, m, true));
  }

  hot.sort(
    (a, b) =>
      accelStrength(
        {
          pct1h: b.pct1h,
          pct15m: metricsMap.get(b.symbol)?.pct15m ?? null,
          pct5m: metricsMap.get(b.symbol)?.pct5m ?? null,
        },
        b.pct24h
      ) -
      accelStrength(
        {
          pct1h: a.pct1h,
          pct15m: metricsMap.get(a.symbol)?.pct15m ?? null,
          pct5m: metricsMap.get(a.symbol)?.pct5m ?? null,
        },
        a.pct24h
      )
  );

  const late = liquid
    .filter((c) => c.pct24h >= LATE_24H)
    .sort((a, b) => b.pct24h - a.pct24h)
    .slice(0, LATE_LIMIT)
    .map((c) =>
      toHotRow(
        c.symbol,
        c.price,
        c.pct24h,
        c.quoteVolume,
        { pct1h: null, pct15m: null, pct5m: null },
        false
      )
    );

  // Attach pct15m into note via unused score field? Keep HotRow as-is;
  // UI shows pct1h + pct24h. Optionally stash 15m in score for debug — no, leave 0.

  const response: HotResponse = {
    updatedAt: new Date().toISOString(),
    cacheTtlSec: Math.round(HOT_TTL / 1000),
    hot: hot.slice(0, PANEL_CAP),
    late,
    meta: {
      enriched1h,
      warnings,
      noteTh:
        `กำลังเร่งตัว = สแกนทุกคู่ USDT-M (vol≥${(MIN_VOL / 1e3).toFixed(0)}k) ด้วย %1h/%15m จริง — ไม่กรอง score/เกรด/funding · หลัง 24h≥${LATE_24H}% ย้ายไปรายการสาย`,
    },
  };

  cacheSet(cacheKey, response, HOT_TTL);
  return response;
}
