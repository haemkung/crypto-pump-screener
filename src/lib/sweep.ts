/**
 * Opposite-side stop-hunt (liquidity sweep) — research heuristic only.
 *
 * Long: a recent candle wicks below a prior swing low / local low (long SL pool)
 * and a close reclaims back above that level. Short is the mirror (sweep of a
 * swing high, then reject back below).
 *
 * Not a trade signal. Missing or failed klines = not confirmed.
 */

import { getKlines, sleep, type KlineBar } from "./binance";

/** One 5m fetch covers ~8h so 15m can be aggregated without a second burst. */
export const SWEEP_5M_LIMIT = 96;
/** Cap like hot.ts — never scan the full universe. */
export const SWEEP_BATCH_CAP = 40;
const SWEEP_CONCURRENCY = 8;

/**
 * Minimum wick through the level (fraction). Ignores equal-low prints;
 * not a price target.
 */
const MIN_PIERCE = 0.0012;

export interface SweepBar {
  open?: number;
  high: number;
  low: number;
  close: number;
  openTime?: number;
  closeTime?: number;
}

export interface SweepDetectOpts {
  /** Most recent closed bars that may contain the wick. */
  recentBars: number;
  /** Bars of structure immediately before that window. */
  structureBars: number;
  pivotLeft: number;
  pivotRight: number;
}

/** 5m: sweep inside the last 4h, structure from the 3h before that. */
export const SWEEP_5M_OPTS: SweepDetectOpts = {
  recentBars: 48,
  structureBars: 36,
  pivotLeft: 2,
  pivotRight: 2,
};

/** 15m: same 4h hunt window, 3h of prior structure. */
export const SWEEP_15M_OPTS: SweepDetectOpts = {
  recentBars: 16,
  structureBars: 12,
  pivotLeft: 1,
  pivotRight: 1,
};

export const LONG_SWEPT_LABEL_TH = "ทะลุแนวรับแล้วแท่งกลับ — เข้าตรงนี้";
export const SHORT_SWEPT_LABEL_TH = "ทะลุแนวต้านแล้วแท่งกลับ — เข้าตรงนี้";
export const WAIT_SWEEP_LABEL_TH = "รอแท่งกลับหลังทะลุ";

export function dropFormingBar(bars: SweepBar[], now = Date.now()): SweepBar[] {
  if (bars.length === 0) return bars;
  const last = bars[bars.length - 1];
  if (last.closeTime != null && Number.isFinite(last.closeTime) && last.closeTime > now) {
    return bars.slice(0, -1);
  }
  return bars;
}

/** Group closed 5m bars into closed 15m bars (drop incomplete buckets). */
export function aggregate5mTo15m(bars: SweepBar[]): SweepBar[] {
  const BUCKET = 15 * 60 * 1000;
  const groups = new Map<
    number,
    { high: number; low: number; close: number; closeTime?: number; n: number }
  >();
  for (const b of bars) {
    if (b.openTime == null || !Number.isFinite(b.openTime)) continue;
    if (![b.high, b.low, b.close].every((n) => Number.isFinite(n))) continue;
    const key = b.openTime - (b.openTime % BUCKET);
    const cur = groups.get(key);
    if (!cur) {
      groups.set(key, {
        high: b.high,
        low: b.low,
        close: b.close,
        closeTime: b.closeTime,
        n: 1,
      });
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.closeTime = b.closeTime ?? cur.closeTime;
      cur.n += 1;
    }
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, g]) => g.n >= 3)
    .map(([openTime, g]) => ({
      openTime,
      high: g.high,
      low: g.low,
      close: g.close,
      closeTime: g.closeTime,
    }));
}

function swingIndexes(
  bars: SweepBar[],
  side: "long" | "short",
  left: number,
  right: number
): number[] {
  const out: number[] = [];
  for (let i = left; i < bars.length - right; i++) {
    const v = side === "long" ? bars[i].low : bars[i].high;
    if (!Number.isFinite(v)) continue;
    let ok = true;
    for (let k = 1; k <= left; k++) {
      const n = side === "long" ? bars[i - k].low : bars[i - k].high;
      if (!Number.isFinite(n) || (side === "long" ? n <= v : n >= v)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    for (let k = 1; k <= right; k++) {
      const n = side === "long" ? bars[i + k].low : bars[i + k].high;
      if (!Number.isFinite(n) || (side === "long" ? n <= v : n >= v)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

export interface SweepHit {
  swept: boolean;
  level: number | null;
}

/**
 * Confirm a sweep+reclaim on one timeframe.
 * Long: wick below prior swing/local low, close back above, last close still above.
 * Short: wick above prior swing/local high, close back below, last close still below.
 */
export function detectSweep(
  barsIn: SweepBar[],
  side: "long" | "short",
  opts: SweepDetectOpts
): SweepHit {
  void opts;
  const bars = dropFormingBar(barsIn).filter(
    (b) =>
      Number.isFinite(b.high) &&
      Number.isFinite(b.low) &&
      Number.isFinite(b.close) &&
      Number.isFinite(b.open ?? b.close) &&
      b.low > 0 &&
      b.high > 0
  );
  // Signal only on the reversal candle itself (last 2 closed bars), not hours later.
  const HUNT = 6;
  const STRUCT = 36;
  if (bars.length < HUNT + 12) return { swept: false, level: null };

  const huntStart = bars.length - HUNT;
  const struct = bars.slice(Math.max(0, huntStart - STRUCT), huntStart);
  if (struct.length < 8) return { swept: false, level: null };

  const pivots = swingIndexes(struct, side, 2, 2);
  const levels: number[] = [];
  for (let i = pivots.length - 1; i >= 0; i--) {
    const p = struct[pivots[i]];
    levels.push(side === "long" ? p.low : p.high);
  }
  if (side === "long") levels.push(Math.min(...struct.map((b) => b.low)));
  else levels.push(Math.max(...struct.map((b) => b.high)));

  const tail = bars.slice(huntStart);
  const seen = new Set<number>();

  for (const level of levels) {
    if (!Number.isFinite(level) || level <= 0 || seen.has(level)) continue;
    seen.add(level);
    const pierce =
      side === "long" ? level * (1 - MIN_PIERCE) : level * (1 + MIN_PIERCE);

    for (let i = 0; i < tail.length - 1; i++) {
      const br = tail[i];
      const broke =
        side === "long"
          ? br.close < level || br.low < pierce
          : br.close > level || br.high > pierce;
      if (!broke) continue;

      const rev = tail[i + 1];
      const open = rev.open ?? rev.close;
      const bullish = rev.close > open;
      const bearish = rev.close < open;
      const reclaimed =
        side === "long"
          ? bullish && rev.close > level
          : bearish && rev.close < level;
      if (!reclaimed) continue;

      const revIndex = huntStart + i + 1;
      // Must still be that reversal print (this bar or the one just before).
      if (revIndex < bars.length - 2) continue;
      return { swept: true, level };
    }
  }

  return { swept: false, level: null };
}

export interface SweepConfirm {
  swept: boolean;
  interval: "5m" | "15m" | null;
  level: number | null;
}

/** 5m first, else 15m built from the same 5m bars. */
export function confirmSweepFrom5m(
  bars5m: SweepBar[],
  side: "long" | "short"
): SweepConfirm {
  const closed = dropFormingBar(bars5m);
  const on5 = detectSweep(closed, side, SWEEP_5M_OPTS);
  if (on5.swept) return { swept: true, interval: "5m", level: on5.level };
  const on15 = detectSweep(aggregate5mTo15m(closed), side, SWEEP_15M_OPTS);
  if (on15.swept) return { swept: true, interval: "15m", level: on15.level };
  return { swept: false, interval: null, level: null };
}

export interface SymbolSweep {
  longSwept: boolean;
  shortSwept: boolean;
  /** Timeframe that confirmed the side that matched; null if neither. */
  interval: "5m" | "15m" | null;
}

const NOT_SWEPT: SymbolSweep = {
  longSwept: false,
  shortSwept: false,
  interval: null,
};

/**
 * Fetch 5m klines (capped) and confirm long + short sweeps.
 * Failures are not-swept — never treat missing data as enter-now.
 */
export async function batchConfirmSweep(
  symbols: string[],
  concurrency = SWEEP_CONCURRENCY
): Promise<Map<string, SymbolSweep>> {
  const out = new Map<string, SymbolSweep>();
  const list = symbols.slice(0, SWEEP_BATCH_CAP);
  for (let i = 0; i < list.length; i += concurrency) {
    const chunk = list.slice(i, i + concurrency);
    await Promise.all(
      chunk.map(async (sym) => {
        try {
          const raw: KlineBar[] = await getKlines(sym, "5m", SWEEP_5M_LIMIT);
          const bars = raw.map((b) => ({
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            openTime: b.openTime,
            closeTime: b.closeTime,
          }));
          const long = confirmSweepFrom5m(bars, "long");
          const short = confirmSweepFrom5m(bars, "short");
          const interval = long.swept
            ? long.interval
            : short.swept
              ? short.interval
              : null;
          out.set(sym, {
            longSwept: long.swept,
            shortSwept: short.swept,
            interval,
          });
        } catch {
          out.set(sym, NOT_SWEPT);
        }
      })
    );
    if (i + concurrency < list.length) await sleep(40);
  }
  return out;
}
