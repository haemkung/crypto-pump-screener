/**
 * "เข้าตอนนี้" / NOW urgency — research heuristic only, not trade signals.
 * Tunable thresholds: defaults in urgencyDefaults; adaptive overrides via learnedWeights.
 */

import type {
  EntryHint,
  Flag,
  NowAlertRow,
  ScreenRow,
  ShortEntryHint,
  ShortFlag,
  UrgencyKind,
} from "./types";
import {
  NOW_LONG_MIN_SCORE,
  NOW_SHORT_MIN_SCORE,
  NOW_LONG_PCT_MIN,
  NOW_LONG_PCT_MAX,
  NOW_SHORT_PCT_MIN,
  NOW_SHORT_PCT_MAX,
} from "./urgencyDefaults";
import { getNowThresholds } from "./learnedWeights";

export {
  NOW_LONG_MIN_SCORE,
  NOW_SHORT_MIN_SCORE,
  NOW_LONG_PCT_MIN,
  NOW_LONG_PCT_MAX,
  NOW_SHORT_PCT_MIN,
  NOW_SHORT_PCT_MAX,
};

export interface UrgencyFields {
  urgency: UrgencyKind | null;
  urgencyLabelTh: string | null;
  urgencyReasonTh: string | null;
  missRiskTh: string | null;
}

export interface UrgencyInput {
  priceChangePercent: number;
  score: number;
  flags: Flag[];
  entry: EntryHint;
  shortScore: number;
  shortFlags: ShortFlag[];
  shortEntry: ShortEntryHint;
}

function hasLongFuel(flags: Flag[]): boolean {
  return (
    flags.includes("neg_funding") || flags.includes("short_squeeze_fuel")
  );
}

function hasShortFuel(flags: ShortFlag[]): boolean {
  return (
    flags.includes("positive_funding") || flags.includes("long_squeeze_fuel")
  );
}

/**
 * Compute urgency for one row. Long and short are mutually exclusive in practice
 * (opposite 24h bands); if both somehow match, Long wins.
 * Thresholds come from learned-weights.json when present, else defaults.
 */
export function computeUrgency(input: UrgencyInput): UrgencyFields {
  const pct = input.priceChangePercent;
  const t = getNowThresholds();

  const longNow =
    input.entry.mode === "early_entry" &&
    input.score >= t.longMinScore &&
    input.flags.includes("early_move") &&
    hasLongFuel(input.flags) &&
    pct >= t.longPctMin &&
    pct <= t.longPctMax;

  const shortNow =
    input.shortEntry.mode === "early_short" &&
    input.shortScore >= t.shortMinScore &&
    input.shortFlags.includes("early_drop") &&
    hasShortFuel(input.shortFlags) &&
    pct >= t.shortPctMin &&
    pct <= t.shortPctMax;

  if (longNow) {
    const volNote = input.flags.includes("high_volume")
      ? "วอลุ่มสูง + "
      : "";
    return {
      urgency: "now_long",
      urgencyLabelTh: "เข้าตอนนี้ (Long)",
      urgencyReasonTh: `${volNote}ต้นทาง Long: score ${input.score}, early_move, funding−, 24h +${pct.toFixed(1)}% ยังในโซนต้น`,
      missRiskTh: "ถ้าไม่เข้าตอนนี้อาจพลาดขาต้นทาง",
    };
  }

  if (shortNow) {
    const volNote = input.shortFlags.includes("high_volume")
      ? "วอลุ่มสูง + "
      : "";
    return {
      urgency: "now_short",
      urgencyLabelTh: "เข้าตอนนี้ (Short)",
      urgencyReasonTh: `${volNote}ต้นทาง Short: shortScore ${input.shortScore}, early_drop, funding+, 24h ${pct.toFixed(1)}% ยังในโซนต้น`,
      missRiskTh: "ถ้าไม่ Short ตอนนี้อาจพลาดขาลงต้นทาง (ระวังเด้งแรง)",
    };
  }

  return {
    urgency: null,
    urgencyLabelTh: null,
    urgencyReasonTh: null,
    missRiskTh: null,
  };
}

/** Soft preference: high_volume first, then score. Caller should pass NOW-only rows. */
export function sortNowRows(rows: ScreenRow[], side: "long" | "short"): ScreenRow[] {
  return [...rows].sort((a, b) => {
    const aVol =
      side === "long"
        ? a.flags.includes("high_volume")
          ? 1
          : 0
        : a.shortFlags.includes("high_volume")
          ? 1
          : 0;
    const bVol =
      side === "long"
        ? b.flags.includes("high_volume")
          ? 1
          : 0
        : b.shortFlags.includes("high_volume")
          ? 1
          : 0;
    if (bVol !== aVol) return bVol - aVol;
    if (side === "long") return b.score - a.score;
    return b.shortScore - a.shortScore;
  });
}

export function toNowAlertRow(r: ScreenRow): NowAlertRow {
  if (!r.urgency || !r.urgencyLabelTh || !r.urgencyReasonTh || !r.missRiskTh) {
    throw new Error(`toNowAlertRow: missing urgency on ${r.symbol}`);
  }
  const isLong = r.urgency === "now_long";
  return {
    symbol: r.symbol,
    baseAsset: r.baseAsset,
    price: r.price,
    priceChangePercent: r.priceChangePercent,
    quoteVolume: r.quoteVolume,
    lastFundingRate: r.lastFundingRate,
    urgency: r.urgency,
    urgencyLabelTh: r.urgencyLabelTh,
    urgencyReasonTh: r.urgencyReasonTh,
    missRiskTh: r.missRiskTh,
    score: r.score,
    shortScore: r.shortScore,
    entryMode: r.entry.mode,
    shortEntryMode: r.shortEntry.mode,
    flags: r.flags,
    shortFlags: r.shortFlags,
    entryLow: isLong ? r.entry.entryLow : r.shortEntry.entryLow,
    entryHigh: isLong ? r.entry.entryHigh : r.shortEntry.entryHigh,
  };
}
