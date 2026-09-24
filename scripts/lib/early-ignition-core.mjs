/**
 * Early-ignition ("เริ่มขยับ") detector core — shared by the live daemon
 * (scripts/early-ignition-daemon.mjs) and the backtest (scripts/backtest-early-ignition.mjs).
 *
 * Works on CLOSED 1m klines as compact arrays: [openTime, open, high, low, close, quoteVolume].
 * Heuristic only — not financial advice.
 */

export const DEFAULT_THRESHOLDS = {
  /** move windows (minutes) — best of these is the "move" */
  moveWindows: [5, 10, 15],
  /** min / max % move over the best window (abs for short) */
  minMovePct: 1.2,
  maxMovePct: 4.5,
  /** max distance from pre-move base (mean close of base window) */
  maxFromBasePct: 5,
  /** base window = the BASE_MIN minutes before the move window */
  baseMinutes: 120,
  /** max (high-low)/low % of the base window — "flat/tight base" */
  maxBaseRangePct: 2.0,
  /** prior range for breakout (minutes before the move window) */
  rangeMinutes: 240,
  /** 5m avg per-minute quote volume vs prior 60m avg per-minute */
  minVolMult: 6,
  /** absolute floor on quote volume in the last 5 bars (USDT) */
  minVol5mUsd: 100_000,
  /** 24h quote volume floor (USDT) */
  min24hVolUsd: 5_000_000,
  /** 24h change must still be modest: long < this, short > -this */
  max24hAbsPct: 3,
  /** also reject if 24h already strongly the other way (avoid dead-cat bounce) */
  opposite24hLimitPct: 15,
  /** close must sit in the upper (long) / lower (short) part of the last bar's range — rejects wick fakeouts */
  minClosePos: 0.5,
  /** allow short (เริ่มทุบ) signals */
  enableShort: true,
};

/** Minimum number of closed bars required for evaluation. */
export function barsNeeded(th = DEFAULT_THRESHOLDS) {
  const maxW = Math.max(...th.moveWindows);
  return Math.max(th.rangeMinutes, th.baseMinutes) + maxW + 5;
}

function maxOf(bars, from, to, idx) {
  let m = -Infinity;
  for (let i = from; i < to; i++) if (bars[i][idx] > m) m = bars[i][idx];
  return m;
}
function minOf(bars, from, to, idx) {
  let m = Infinity;
  for (let i = from; i < to; i++) if (bars[i][idx] < m) m = bars[i][idx];
  return m;
}
function sumOf(bars, from, to, idx) {
  let s = 0;
  for (let i = from; i < to; i++) s += bars[i][idx];
  return s;
}

/**
 * Evaluate bar index t (closed) of `bars`.
 * ctx: { pct24h, vol24hUsd } — from live ticker, or derived in backtest.
 * Returns null or a signal object.
 */
export function evaluateIgnition(bars, t, ctx, th = DEFAULT_THRESHOLDS) {
  const need = barsNeeded(th);
  if (t < need - 1 || t >= bars.length) return null;
  const pct24h = Number(ctx?.pct24h);
  const vol24h = Number(ctx?.vol24hUsd);
  if (!Number.isFinite(pct24h)) return null;
  if (Number.isFinite(vol24h) && vol24h < th.min24hVolUsd) return null;

  const close = bars[t][4];
  if (!(close > 0)) return null;

  // Best move over windows (signed): pick the one with largest |move|.
  let bestUp = { pct: -Infinity, w: 0 };
  let bestDn = { pct: Infinity, w: 0 };
  for (const w of th.moveWindows) {
    const ref = bars[t - w][4];
    if (!(ref > 0)) continue;
    const p = (close / ref - 1) * 100;
    if (p > bestUp.pct) bestUp = { pct: p, w };
    if (p < bestDn.pct) bestDn = { pct: p, w };
  }
  const maxW = Math.max(...th.moveWindows);
  const moveStart = t - maxW; // bars [moveStart+1 .. t] are the move window

  // Volume spike: last 5 bars per-minute vs prior 60 per-minute (excluding last 5).
  const vol5 = sumOf(bars, t - 4, t + 1, 5);
  const volPrior = sumOf(bars, t - 64, t - 4, 5) / 60;
  const volMult = volPrior > 0 ? vol5 / 5 / volPrior : vol5 > 0 ? 99 : 0;
  if (volMult < th.minVolMult || vol5 < th.minVol5mUsd) return null;

  // Base window (tightness) and prior range (breakout)
  const baseFrom = moveStart - th.baseMinutes;
  const baseHigh = maxOf(bars, baseFrom, moveStart + 1, 2);
  const baseLow = minOf(bars, baseFrom, moveStart + 1, 3);
  const baseRangePct = ((baseHigh - baseLow) / baseLow) * 100;
  if (baseRangePct > th.maxBaseRangePct) return null;
  const baseMean = sumOf(bars, baseFrom, moveStart + 1, 4) / (moveStart + 1 - baseFrom);

  const rangeFrom = moveStart - th.rangeMinutes;
  const rangeHigh = maxOf(bars, rangeFrom, moveStart + 1, 2);
  const rangeLow = minOf(bars, rangeFrom, moveStart + 1, 3);

  const [, , lastH, lastL] = bars[t];
  const posLong = lastH > lastL ? (close - lastL) / (lastH - lastL) : 0.5;

  const common = {
    close,
    pct24h,
    vol24hUsd: Number.isFinite(vol24h) ? vol24h : null,
    volMult: Math.round(volMult * 10) / 10,
    vol5mUsd: Math.round(vol5),
    baseRangePct: Math.round(baseRangePct * 100) / 100,
    baseMean,
    rangeHigh,
    rangeLow,
    barTime: bars[t][0],
  };

  // LONG
  if (
    bestUp.pct >= th.minMovePct &&
    bestUp.pct <= th.maxMovePct &&
    close > rangeHigh &&
    posLong >= th.minClosePos &&
    pct24h < th.max24hAbsPct &&
    pct24h > -th.opposite24hLimitPct
  ) {
    const fromBasePct = (close / baseMean - 1) * 100;
    if (fromBasePct <= th.maxFromBasePct) {
      return {
        side: "long",
        movePct: Math.round(bestUp.pct * 100) / 100,
        moveWindow: bestUp.w,
        fromBasePct: Math.round(fromBasePct * 100) / 100,
        breakoutPct: Math.round((close / rangeHigh - 1) * 10000) / 100,
        ...common,
        score: baseScore(bestUp.pct, volMult, baseRangePct, pct24h, "long"),
      };
    }
  }
  // SHORT
  if (
    th.enableShort &&
    bestDn.pct <= -th.minMovePct &&
    bestDn.pct >= -th.maxMovePct &&
    close < rangeLow &&
    1 - posLong >= th.minClosePos &&
    pct24h > -th.max24hAbsPct &&
    pct24h < th.opposite24hLimitPct
  ) {
    const fromBasePct = (close / baseMean - 1) * 100;
    if (fromBasePct >= -th.maxFromBasePct) {
      return {
        side: "short",
        movePct: Math.round(bestDn.pct * 100) / 100,
        moveWindow: bestDn.w,
        fromBasePct: Math.round(fromBasePct * 100) / 100,
        breakoutPct: Math.round((close / rangeLow - 1) * 10000) / 100,
        ...common,
        score: baseScore(-bestDn.pct, volMult, baseRangePct, pct24h, "short"),
      };
    }
  }
  return null;
}

/** 0..100-ish ranking score (used for burst cap ordering), bonuses added by caller. */
function baseScore(absMove, volMult, baseRangePct, pct24h, side) {
  let s = 40;
  s += Math.min(20, (volMult - 3) * 3);
  s += absMove >= 2 && absMove <= 3.5 ? 10 : 5;
  s += baseRangePct < 1.5 ? 10 : baseRangePct < 2.5 ? 5 : 0;
  const p = side === "long" ? pct24h : -pct24h;
  s += p < 2 ? 5 : 0;
  return Math.round(s);
}

/**
 * Outcome: from entry at bars[t].close, did price reach +winPct before -lossPct
 * (side-adjusted) within `horizon` bars? Same-bar ambiguity counts as loss.
 */
export function gradePath(bars, t, side, winPct = 3, lossPct = 2, horizon = 240) {
  const entry = bars[t][4];
  const up = side === "long" ? entry * (1 + winPct / 100) : entry * (1 - winPct / 100);
  const dn = side === "long" ? entry * (1 - lossPct / 100) : entry * (1 + lossPct / 100);
  let mfe = 0;
  const end = Math.min(bars.length - 1, t + horizon);
  for (let i = t + 1; i <= end; i++) {
    const [, , h, l] = bars[i];
    const fav = side === "long" ? (h / entry - 1) * 100 : (1 - l / entry) * 100;
    if (fav > mfe) mfe = fav;
    const hitWin = side === "long" ? h >= up : l <= up;
    const hitLoss = side === "long" ? l <= dn : h >= dn;
    if (hitLoss) return { result: "loss", bars: i - t, mfe };
    if (hitWin) return { result: "win", bars: i - t, mfe };
  }
  return { result: end - t < horizon ? "open" : "timeout", bars: end - t, mfe };
}

export const DEDUPE_MS = 2 * 60 * 60 * 1000;
/** Re-alert inside the dedupe window only if price made a new leg this far beyond the last alert. */
export const NEW_LEG_PCT = 3;
export const MAX_PER_CYCLE = 3;

/**
 * Dedupe decision. `sent` maps "SYMBOL|side" -> { at, price }.
 */
export function dedupeAllows(sent, symbol, side, price, nowMs) {
  const prev = sent[`${symbol}|${side}`];
  if (!prev || !Number.isFinite(prev.at) || nowMs - prev.at >= DEDUPE_MS) return true;
  if (!(prev.price > 0)) return false;
  const leg = side === "long" ? (price / prev.price - 1) * 100 : (1 - price / prev.price) * 100;
  return leg >= NEW_LEG_PCT;
}

/** Min move vs BTC over the same window (drops market-wide sweeps). Tuned on 3 days of 1m data. */
export const MIN_REL_MOVE = { long: 1.3, short: 1.5 };

/** Market-wide move filter: subtract BTC's move over the same window. */
export function relMove(signal, btcMovePct) {
  if (!Number.isFinite(btcMovePct)) return Math.abs(signal.movePct);
  return signal.side === "long" ? signal.movePct - btcMovePct : -(signal.movePct - btcMovePct);
}

// ---------------------------------------------------------------------------
// WATCH tier (5m cadence): 👀 กำลังสะสม (accumulation, long watch)
//                          👀 กำลังแจกของ (distribution, short watch)
// Inputs are 5m price points + 5m open-interest points (Binance openInterestHist).
// ---------------------------------------------------------------------------

export const WATCH_THRESHOLDS = {
  /** window (5m bars) for flat-price + OI-rise check; 36 = 3h */
  windowBars: 36,
  /** accumulation: max (high-low)/low % of price over the window */
  accMaxRangePct: 3.5,
  /** min OI rise over the window (%, vs. min OI in the window's first half) */
  accMinOiPct: 6,
  /** accumulation only while 24h change is still modest */
  accMax24hAbsPct: 8,
  /** distribution: coin already pumped — 24h high >= this % above 24h low */
  distMinPumpPct: 15,
  /** distribution: price must still be at least this far above the 24h low */
  distMinAboveLowPct: 8,
  /** distribution: last-window high must be at least this % below the 24h high (failed new high) */
  distMinBelowHighPct: 2,
  distMaxRangePct: 5,
  distMinOiPct: 5,
  min24hVolUsd: 5_000_000,
};

/**
 * price5: array of [ts, high, low, close] (5m), oi5: array of [ts, sumOpenInterest] aligned
 * (same length, same timestamps; caller aligns). day: { high24, low24, pct24h, vol24hUsd }.
 * Evaluates the last element. Returns null or { tier: "accumulation"|"distribution", ... }.
 */
export function evaluateWatch(price5, oi5, day, th = WATCH_THRESHOLDS) {
  const W = th.windowBars;
  const n = price5.length;
  if (n < W + 1 || oi5.length !== n) return null;
  if (Number.isFinite(day.vol24hUsd) && day.vol24hUsd < th.min24hVolUsd) return null;
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = n - W; i < n; i++) {
    if (price5[i][1] > hi) hi = price5[i][1];
    if (price5[i][2] < lo) lo = price5[i][2];
  }
  const rangePct = ((hi - lo) / lo) * 100;
  // OI rise: now vs min OI in the first half of the window (robust to a single spike)
  let oiMinEarly = Infinity;
  for (let i = n - W; i < n - W / 2; i++) if (oi5[i][1] > 0 && oi5[i][1] < oiMinEarly) oiMinEarly = oi5[i][1];
  const oiNow = oi5[n - 1][1];
  if (!(oiNow > 0) || !Number.isFinite(oiMinEarly)) return null;
  const oiChangePct = (oiNow / oiMinEarly - 1) * 100;
  const oiStart = oi5[n - W][1];
  const oiWindowPct = oiStart > 0 ? (oiNow / oiStart - 1) * 100 : null;
  const close = price5[n - 1][3];
  const base = {
    close,
    rangePct: Math.round(rangePct * 100) / 100,
    oiChangePct: Math.round(oiChangePct * 100) / 100,
    oiWindowPct: oiWindowPct != null ? Math.round(oiWindowPct * 100) / 100 : null,
    windowHours: (W * 5) / 60,
    pct24h: day.pct24h,
    ts: price5[n - 1][0],
  };
  // Accumulation: flat price, OI building, 24h modest, and price NOT drifting down hard
  if (
    rangePct <= th.accMaxRangePct &&
    oiChangePct >= th.accMinOiPct &&
    Math.abs(day.pct24h) < th.accMax24hAbsPct
  ) {
    return { tier: "accumulation", side: "long", ...base };
  }
  // Distribution: pumped coin, stalls below its 24h high while OI keeps rising
  const pump = day.low24 > 0 ? (day.high24 / day.low24 - 1) * 100 : 0;
  const aboveLow = day.low24 > 0 ? (close / day.low24 - 1) * 100 : 0;
  const belowHigh = day.high24 > 0 ? (1 - hi / day.high24) * 100 : 0;
  if (
    pump >= th.distMinPumpPct &&
    aboveLow >= th.distMinAboveLowPct &&
    belowHigh >= th.distMinBelowHighPct &&
    rangePct <= th.distMaxRangePct &&
    oiChangePct >= th.distMinOiPct
  ) {
    return {
      tier: "distribution",
      side: "short",
      ...base,
      pumpPct: Math.round(pump * 10) / 10,
      belowHighPct: Math.round(belowHigh * 100) / 100,
    };
  }
  return null;
}

/** 5m path grade: side-adjusted +win before -loss within horizon bars (5m), from close at index t. */
export function gradePath5(price5, t, side, winPct = 3, lossPct = 2, horizon = 96) {
  const entry = price5[t][3];
  let mfe = 0;
  const end = Math.min(price5.length - 1, t + horizon);
  for (let i = t + 1; i <= end; i++) {
    const [, h, l] = price5[i];
    const fav = side === "long" ? (h / entry - 1) * 100 : (1 - l / entry) * 100;
    const adv = side === "long" ? (1 - l / entry) * 100 : (h / entry - 1) * 100;
    if (fav > mfe) mfe = fav;
    if (adv >= lossPct) return { result: "loss", bars: i - t, mfe };
    if (fav >= winPct) return { result: "win", bars: i - t, mfe };
  }
  return { result: end - t < horizon ? "open" : "timeout", bars: end - t, mfe };
}
