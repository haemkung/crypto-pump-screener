/**
 * "เข้าตอนนี้" / NOW urgency — research heuristic only, not trade signals.
 * Tunable thresholds: defaults in urgencyDefaults; adaptive overrides via learnedWeights.
 * MTF against blocks NOW; regime risk-off dampens thin Long NOW; false patterns can block.
 *
 * computeUrgency is the setup gate only. applySweepGate then withholds now_*
 * until an opposite-side SL sweep+reclaim is confirmed (see sweep.ts).
 */

import type {
  EntryHint,
  Flag,
  MarketRegime,
  MtfAlign,
  NowAlertRow,
  QualityGrade,
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
import { isThinOrSmallCap, longNowRegimeGate } from "./regime";

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
  quoteVolume?: number;
  hasSpot?: boolean;
  /** Long-side MTF */
  mtfLong?: MtfAlign | null;
  /** Short-side MTF */
  mtfShort?: MtfAlign | null;
  regime?: MarketRegime | null;
  falsePatternLong?: boolean;
  falsePatternShort?: boolean;
  falsePatternBlockLong?: boolean;
  falsePatternBlockShort?: boolean;
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

  let longNow =
    input.entry.mode === "early_entry" &&
    input.score >= t.longMinScore &&
    input.flags.includes("early_move") &&
    hasLongFuel(input.flags) &&
    pct >= t.longPctMin &&
    pct <= t.longPctMax;

  let shortNow =
    input.shortEntry.mode === "early_short" &&
    input.shortScore >= t.shortMinScore &&
    input.shortFlags.includes("early_drop") &&
    hasShortFuel(input.shortFlags) &&
    pct >= t.shortPctMin &&
    pct <= t.shortPctMax;

  // MTF: against blocks; mixed allowed (caller may grade lower)
  if (longNow && input.mtfLong === "mtf_against") longNow = false;
  if (shortNow && input.mtfShort === "mtf_against") shortNow = false;

  // False-pattern hard block
  if (longNow && input.falsePatternBlockLong) longNow = false;
  if (shortNow && input.falsePatternBlockShort) shortNow = false;

  // Regime dampen Long NOW for thin names
  let regimeNote: string | null = null;
  if (longNow && input.regime) {
    const thin = isThinOrSmallCap({
      quoteVolume: input.quoteVolume ?? 0,
      flags: input.flags,
      shortFlags: input.shortFlags,
      hasSpot: input.hasSpot,
    });
    const gate = longNowRegimeGate(input.regime, input.score, thin);
    regimeNote = gate.noteTh;
    if (gate.block) longNow = false;
  }

  if (longNow) {
    const volNote = input.flags.includes("high_volume")
      ? "วอลุ่มสูง + "
      : "";
    const mtfNote =
      input.mtfLong === "mtf_align"
        ? " · MTF align"
        : input.mtfLong === "mtf_mixed"
          ? " · MTF mixed"
          : "";
    const fpNote = input.falsePatternLong ? " · ระวัง false pattern" : "";
    return {
      urgency: "now_long",
      urgencyLabelTh: "เข้าตอนนี้ (Long)",
      urgencyReasonTh: `${volNote}ต้นทาง Long: score ${input.score}, early_move, funding−, 24h +${pct.toFixed(1)}% ยังในโซนต้น${mtfNote}${fpNote}${regimeNote ? " · " + regimeNote : ""}`,
      missRiskTh: "ถ้าไม่เข้าตอนนี้อาจพลาดขาต้นทาง",
    };
  }

  if (shortNow) {
    const volNote = input.shortFlags.includes("high_volume")
      ? "วอลุ่มสูง + "
      : "";
    const mtfNote =
      input.mtfShort === "mtf_align"
        ? " · MTF align"
        : input.mtfShort === "mtf_mixed"
          ? " · MTF mixed"
          : "";
    const fpNote = input.falsePatternShort ? " · ระวัง false pattern" : "";
    return {
      urgency: "now_short",
      urgencyLabelTh: "เข้าตอนนี้ (Short)",
      urgencyReasonTh: `${volNote}ต้นทาง Short: shortScore ${input.shortScore}, early_drop, funding+, 24h ${pct.toFixed(1)}% ยังในโซนต้น${mtfNote}${fpNote}`,
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


export interface SweepGateInput {
  /** Opposite-side sweep already reclaimed. Missing/false = wait, never enter-now. */
  confirmed: boolean;
  interval?: "5m" | "15m" | null;
}

/**
 * If the setup is hot but the opposite-side sweep has not reclaimed, downgrade
 * to a wait state. Enter-now labels only after confirmation.
 */
export function applySweepGate(
  fields: UrgencyFields,
  sweep: SweepGateInput
): UrgencyFields {
  if (fields.urgency !== "now_long" && fields.urgency !== "now_short") {
    return fields;
  }
  const isLong = fields.urgency === "now_long";
  const tf = sweep.interval === "5m" || sweep.interval === "15m" ? sweep.interval : null;
  if (sweep.confirmed) {
    const label = isLong
      ? "ทะลุแนวรับแล้วแท่งกลับ — เข้าตรงนี้"
      : "ทะลุแนวต้านแล้วแท่งกลับ — เข้าตรงนี้";
    const tfNote = tf ? ` (${tf})` : "";
    return {
      urgency: fields.urgency,
      urgencyLabelTh: label,
      urgencyReasonTh: `${fields.urgencyReasonTh ?? ""} · แท่งกลับตัวหลังทะลุ${tfNote}`.trim(),
      missRiskTh: isLong
        ? "ลงมากิน SL อีกฝั่งแล้ว — ถ้าไม่เข้าอาจพลาดขาต่อ (heuristic)"
        : "ขึ้นมากิน SL อีกฝั่งแล้ว — ถ้าไม่ Short อาจพลาดขาต่อ (heuristic, ระวังเด้ง)",
    };
  }
  return {
    urgency: isLong ? "wait_sweep_long" : "wait_sweep_short",
    urgencyLabelTh: "รอแท่งกลับหลังทะลุ",
    urgencyReasonTh: isLong
      ? "ยังไม่ใช่จังหวะ — รอให้ทะลุแนวรับแล้วมีแท่งกลับตัวปิดเหนือแนว ถึงจะเข้า"
      : "ยังไม่ใช่จังหวะ — รอให้ทะลุแนวต้านแล้วมีแท่งกลับตัวปิดใต้แนว ถึงจะเข้า",
    missRiskTh: "ยังไม่ใช่จังหวะเข้า — รอกิน SL อีกฝั่งก่อน",
  };
}

/** Soft preference: high_volume first, then quality grade, then score. */
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
    const aG =
      side === "long" ? a.qualityGrade : a.shortQualityGrade;
    const bG =
      side === "long" ? b.qualityGrade : b.shortQualityGrade;
    const rank = (g: QualityGrade) => (g === "A" ? 3 : g === "B" ? 2 : 1);
    if (rank(bG) !== rank(aG)) return rank(bG) - rank(aG);
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
    qualityGrade: isLong ? r.qualityGrade : r.shortQualityGrade,
    mtfAlign: r.mtfAlign,
    falsePatternRisk: r.falsePatternRisk,
    sweepConfirmed: r.urgency === "now_long" || r.urgency === "now_short",
  };
}
