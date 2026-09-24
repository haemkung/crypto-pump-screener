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

// ---------------------------------------------------------------------------
// CONFLUENCE evidence ("hidden" positioning before the move). Rule-based, each factor independent.
// A price move alone NEVER qualifies; alerts need >= minFactors of these, measured BEFORE the move.
// ---------------------------------------------------------------------------

export const EVIDENCE_THRESHOLDS = {
  /** F1 OI build: OI rise over lookback while price stays flat */
  oiLookbackBars: 48, // 5m bars = 4h
  oiMinRisePct: 5,
  oiMaxPriceChangePct: 2.5,
  oiMaxPriceRangePct: 5,
  /** F2 funding: long wants shorts paying, short wants crowded longs paying */
  fundingLongMaxPct: -0.005,
  fundingShortMinPct: 0.03,
  /** F3 crowded opposite side via global long/short account ratio */
  lsLongMax: 1.0, // or falling >= lsDropPct over lookback
  lsShortMin: 2.5, // or rising >= lsDropPct
  lsChangePct: 8,
  /** F4 taker imbalance (futures taker buy/sell volume) */
  takerLong1h: 1.15,
  takerLong3h: 1.05,
  takerShort1h: 0.87,
  takerShort3h: 0.95,
  /** F5 quiet inflow: 2h perp volume vs prior 22h, price 2h range small */
  inflowMult: 1.8,
  inflowMaxRangePct: 3,
  /** F6 spot leading: spot 1h volume vs prior 24h hourly avg + spot taker side */
  spotVolMult: 2,
  spotTakerLongMin: 55,
  spotTakerShortMax: 45,
  /** F7 short only: already pumped and fading */
  fadeMinPumpPct: 15,
  fadeMinBelowHighPct: 3,
};

/** Factor keys + Thai labels (used in messages). */
export const FACTOR_LABELS = {
  oiBuild: "OI สะสมขณะราคานิ่ง",
  funding: "funding เอียงฝั่งตรงข้าม",
  crowded: "ฝั่งตรงข้ามแน่น (L/S)",
  taker: "แรง taker เอียง",
  inflow: "วอลุ่มไหลเข้าเงียบ",
  spot: "spot นำ",
  fade: "พุ่งแรงแล้วหมดแรง",
};

function lastIdxAtOrBefore(arr, ts) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m][0] <= ts) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}

/**
 * Evaluate confluence factors for `side` as of timestamp `asOf` (ms; use the time BEFORE the price move).
 * data: {
 *   p5: [[ts, high, low, close, quoteVol]] perp 5m (ascending), oi5: [[ts, oi]], ls5: [[ts, ratio]],
 *   tk5: [[ts, buyVol, sellVol]], spot5: [[ts, close, quoteVol, takerBuyQuoteVol]] | null,
 *   fundingPct: number | null, day: { high24, low24 } | null
 * }
 * Returns { count, directional, factors: [{ key, labelTh, detailTh, value }] }.
 */
export function evaluateEvidence(side, data, asOf, th = EVIDENCE_THRESHOLDS) {
  const factors = [];
  const add = (key, detailTh, value) => factors.push({ key, labelTh: FACTOR_LABELS[key], detailTh, value });
  const L = th.oiLookbackBars;
  const f2 = (n) => (n > 0 ? "+" : "") + n.toFixed(2);

  // F1 OI build with flat price
  const p5 = data.p5 || [];
  const pi = lastIdxAtOrBefore(p5, asOf);
  const oi5 = data.oi5 || [];
  const oi = lastIdxAtOrBefore(oi5, asOf);
  if (pi >= L && oi >= L) {
    const oiNow = oi5[oi][1];
    let oiMin = Infinity;
    for (let i = oi - L; i <= oi - L / 2; i++) if (oi5[i][1] > 0 && oi5[i][1] < oiMin) oiMin = oi5[i][1];
    const oiRise = (oiNow / oiMin - 1) * 100;
    let hi = -Infinity, lo = Infinity;
    for (let i = pi - L + 1; i <= pi; i++) { hi = Math.max(hi, p5[i][1]); lo = Math.min(lo, p5[i][2]); }
    const pChg = (p5[pi][3] / p5[pi - L][3] - 1) * 100;
    const rng = ((hi - lo) / lo) * 100;
    if (oiRise >= th.oiMinRisePct && Math.abs(pChg) <= th.oiMaxPriceChangePct && rng <= th.oiMaxPriceRangePct) {
      add("oiBuild", `OI ${f2(oiRise)}% ใน ${(L * 5) / 60} ชม. ขณะราคา ${f2(pChg)}% (กรอบ ${rng.toFixed(1)}%)`, { oiRise, pChg, rng });
    }
  }

  // F2 funding
  const fr = data.fundingPct;
  if (Number.isFinite(fr)) {
    if (side === "long" && fr <= th.fundingLongMaxPct) add("funding", `funding ${fr.toFixed(4)}% (short จ่าย long)`, fr);
    if (side === "short" && fr >= th.fundingShortMinPct) add("funding", `funding ${fr.toFixed(4)}% (long จ่ายแพง)`, fr);
  }

  // F3 crowded opposite side (global L/S account ratio)
  const ls5 = data.ls5 || [];
  const li = lastIdxAtOrBefore(ls5, asOf);
  if (li >= L) {
    const now = ls5[li][1], prev = ls5[li - L][1];
    const chg = prev > 0 ? (now / prev - 1) * 100 : 0;
    if (side === "long" && (now <= th.lsLongMax || chg <= -th.lsChangePct)) add("crowded", `L/S ${now.toFixed(2)} (4 ชม. ${f2(chg)}%) — short แน่น`, { now, chg });
    if (side === "short" && (now >= th.lsShortMin || chg >= th.lsChangePct)) add("crowded", `L/S ${now.toFixed(2)} (4 ชม. ${f2(chg)}%) — long แน่น`, { now, chg });
  }

  // F4 taker imbalance
  const tk5 = data.tk5 || [];
  const ti = lastIdxAtOrBefore(tk5, asOf);
  if (ti >= 36) {
    const r = (a, b) => { let bu = 0, se = 0; for (let i = a; i <= b; i++) { bu += tk5[i][1]; se += tk5[i][2]; } return se > 0 ? bu / se : null; };
    const r1 = r(ti - 11, ti), r3 = r(ti - 35, ti);
    if (r1 != null && r3 != null) {
      if (side === "long" && r1 >= th.takerLong1h && r3 >= th.takerLong3h) add("taker", `taker buy/sell 1h ${r1.toFixed(2)} · 3h ${r3.toFixed(2)}`, { r1, r3 });
      if (side === "short" && r1 <= th.takerShort1h && r3 <= th.takerShort3h) add("taker", `taker buy/sell 1h ${r1.toFixed(2)} · 3h ${r3.toFixed(2)}`, { r1, r3 });
    }
  }

  // F5 quiet inflow (non-directional support)
  if (pi >= 288) {
    let v2 = 0, v22 = 0, hi = -Infinity, lo = Infinity;
    for (let i = pi - 23; i <= pi; i++) { v2 += p5[i][4]; hi = Math.max(hi, p5[i][1]); lo = Math.min(lo, p5[i][2]); }
    for (let i = pi - 287; i < pi - 23; i++) v22 += p5[i][4];
    const mult = v22 > 0 ? v2 / 24 / (v22 / 264) : 0;
    const rng = ((hi - lo) / lo) * 100;
    if (mult >= th.inflowMult && rng <= th.inflowMaxRangePct) add("inflow", `วอลุ่ม 2 ชม. ×${mult.toFixed(1)} ของเฉลี่ย 22 ชม. ขณะกรอบราคา ${rng.toFixed(1)}%`, { mult, rng });
  }

  // F6 spot leading
  const s5 = data.spot5;
  if (s5 && s5.length) {
    const si = lastIdxAtOrBefore(s5, asOf);
    if (si >= 300) {
      let v1 = 0, tb = 0, v24 = 0;
      for (let i = si - 11; i <= si; i++) { v1 += s5[i][2]; tb += s5[i][3]; }
      for (let i = si - 299; i < si - 11; i++) v24 += s5[i][2];
      const mult = v24 > 0 ? v1 / (v24 / 24) : 0;
      const buyPct = v1 > 0 ? (tb / v1) * 100 : 50;
      if (mult >= th.spotVolMult) {
        if (side === "long" && buyPct >= th.spotTakerLongMin) add("spot", `spot วอลุ่ม 1 ชม. ×${mult.toFixed(1)} · spot ซื้อ ${buyPct.toFixed(0)}%`, { mult, buyPct });
        if (side === "short" && buyPct <= th.spotTakerShortMax) add("spot", `spot วอลุ่ม 1 ชม. ×${mult.toFixed(1)} · spot ขาย ${(100 - buyPct).toFixed(0)}%`, { mult, buyPct });
      }
    }
  }

  // F7 short only: pumped then fading
  if (side === "short" && data.day && pi >= 0) {
    const { high24, low24 } = data.day;
    const pump = low24 > 0 ? (high24 / low24 - 1) * 100 : 0;
    const below = high24 > 0 ? (1 - p5[pi][3] / high24) * 100 : 0;
    if (pump >= th.fadeMinPumpPct && below >= th.fadeMinBelowHighPct) add("fade", `24h พุ่ง ${pump.toFixed(0)}% แล้วย่อจากยอด ${below.toFixed(1)}%`, { pump, below });
  }

  const directional = factors.filter((f) => f.key !== "oiBuild" && f.key !== "inflow").length;
  return { count: factors.length, directional, factors };
}

/**
 * Price TIMING trigger used after confluence (looser than DEFAULT_THRESHOLDS — the price move is
 * never sufficient on its own; evidence factors do the filtering).
 */
export const TRIGGER_THRESHOLDS = {
  ...DEFAULT_THRESHOLDS,
  minMovePct: 1.0,
  maxMovePct: 6,
  maxBaseRangePct: 4,
  minVolMult: 3,
  minVol5mUsd: 50_000,
  max24hAbsPct: 8,
  opposite24hLimitPct: 30,
};

/** Minimum evidence required per tier (tuned for precision; see scripts/backtest-early-confluence.mjs). */
export const CONFLUENCE_RULES = {
  ignitionMinFactors: 3,
  ignitionMinDirectional: 1,
  watchMinFactors: 3,
  watchMinDirectional: 2,
};
