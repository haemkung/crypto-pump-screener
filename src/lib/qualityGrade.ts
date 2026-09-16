/**
 * Quality grade A/B/C from score, funding, MTF, regime, learned WR, false patterns.
 * Heuristic research only — not financial advice.
 */

import type {
  MarketRegime,
  MtfAlign,
  QualityGrade,
  ScreenRow,
} from "./types";
import { getNowThresholds } from "./learnedWeights";
import { isThinOrSmallCap } from "./regime";

export interface QualityInput {
  side: "long" | "short";
  score: number;
  shortScore: number;
  lastFundingRate: number | null;
  mtfAlign: MtfAlign | null;
  regime: MarketRegime | null;
  falsePatternRisk: boolean;
  quoteVolume: number;
  flags: string[];
  shortFlags: string[];
  hasSpot: boolean;
}

export function computeQualityGrade(input: QualityInput): QualityGrade {
  const side = input.side;
  const score = side === "long" ? input.score : input.shortScore;
  let pts = 0;

  if (score >= 70) pts += 3;
  else if (score >= 55) pts += 2;
  else if (score >= 40) pts += 1;

  const fr = input.lastFundingRate;
  if (fr != null && Number.isFinite(fr)) {
    if (side === "long" && fr < 0) pts += 1;
    if (side === "short" && fr > 0) pts += 1;
  }

  if (input.mtfAlign === "mtf_align") pts += 2;
  else if (input.mtfAlign === "mtf_against") pts -= 2;
  // mixed / null → 0

  const regime = input.regime;
  if (regime) {
    const thin = isThinOrSmallCap(input);
    if (side === "long") {
      if (regime.kind === "risk_off") pts -= thin ? 2 : 1;
      if (regime.kind === "risk_on") pts += 1;
    } else {
      if (regime.kind === "risk_off") pts += 1;
      if (regime.kind === "risk_on") pts -= 1;
    }
  }

  const t = getNowThresholds();
  const wr =
    side === "long"
      ? t.learned?.long?.winRate ?? null
      : t.learned?.short?.winRate ?? null;
  const graded =
    side === "long"
      ? t.learned?.long?.graded ?? 0
      : t.learned?.short?.graded ?? 0;
  if (graded >= 5 && wr != null) {
    if (wr >= 0.55) pts += 1;
    else if (wr < 0.4) pts -= 1;
  }

  if (input.falsePatternRisk) pts -= 2;

  if (pts >= 5) return "A";
  if (pts >= 3) return "B";
  return "C";
}

/** Grade for both sides; pick the active-side grade for display helpers. */
export function gradeRow(
  row: Pick<
    ScreenRow,
    | "score"
    | "shortScore"
    | "lastFundingRate"
    | "quoteVolume"
    | "flags"
    | "shortFlags"
    | "hasSpot"
  >,
  mtfLong: MtfAlign | null,
  mtfShort: MtfAlign | null,
  regime: MarketRegime | null,
  falseLong: boolean,
  falseShort: boolean
): { qualityGrade: QualityGrade; shortQualityGrade: QualityGrade } {
  const qualityGrade = computeQualityGrade({
    side: "long",
    score: row.score,
    shortScore: row.shortScore,
    lastFundingRate: row.lastFundingRate,
    mtfAlign: mtfLong,
    regime,
    falsePatternRisk: falseLong,
    quoteVolume: row.quoteVolume,
    flags: row.flags,
    shortFlags: row.shortFlags,
    hasSpot: row.hasSpot,
  });
  const shortQualityGrade = computeQualityGrade({
    side: "short",
    score: row.score,
    shortScore: row.shortScore,
    lastFundingRate: row.lastFundingRate,
    mtfAlign: mtfShort,
    regime,
    falsePatternRisk: falseShort,
    quoteVolume: row.quoteVolume,
    flags: row.flags,
    shortFlags: row.shortFlags,
    hasSpot: row.hasSpot,
  });
  return { qualityGrade, shortQualityGrade };
}

export function gradeRank(g: QualityGrade | null | undefined): number {
  if (g === "A") return 3;
  if (g === "B") return 2;
  if (g === "C") return 1;
  return 0;
}

export function meetsMinGrade(
  grade: QualityGrade | null | undefined,
  minGrade: QualityGrade,
  score: number,
  allowStrongB = true
): boolean {
  const g = grade || "C";
  if (minGrade === "C") return true;
  if (minGrade === "B") return g === "A" || g === "B";
  // minGrade A: allow A, and strong B
  if (g === "A") return true;
  if (allowStrongB && g === "B" && score >= 65) return true;
  return false;
}
