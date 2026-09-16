/** Shared types for the pump / dump pattern screener */

export type ScreenMode = "long" | "short";

export type UrgencyKind = "now_long" | "now_short";

export type MtfAlign = "mtf_align" | "mtf_mixed" | "mtf_against";

export type RegimeKind = "risk_on" | "neutral" | "risk_off";

export type QualityGrade = "A" | "B" | "C";

export type Flag =
  | "early_move"
  | "late_chase"
  | "neg_funding"
  | "thin_liquidity"
  | "no_spot"
  | "high_volume"
  | "oi_rising"
  | "short_squeeze_fuel"
  | "catalyst"
  | "mtf_align"
  | "mtf_mixed"
  | "mtf_against"
  | "false_pattern_risk";

export type ShortFlag =
  | "early_drop"
  | "late_short_chase"
  | "positive_funding"
  | "long_squeeze_fuel"
  | "thin_liquidity"
  | "no_spot"
  | "high_volume"
  | "oi_rising"
  | "catalyst"
  | "mtf_align"
  | "mtf_mixed"
  | "mtf_against"
  | "false_pattern_risk";

export type EntryMode =
  | "early_entry"
  | "wait_pullback"
  | "too_late"
  | "watch_only";

export type ShortEntryMode =
  | "early_short"
  | "wait_bounce"
  | "too_late_short"
  | "watch_only_short";

export interface EntryHint {
  mode: EntryMode;
  labelTh: string;
  entryLow: number | null;
  entryHigh: number | null;
  invalidation: string;
  entryNote: string;
}

export interface ShortEntryHint {
  mode: ShortEntryMode;
  labelTh: string;
  entryLow: number | null;
  entryHigh: number | null;
  invalidation: string;
  entryNote: string;
}

export interface ScoreBreakdown {
  earlyMove: number;
  volume: number;
  funding: number;
  liquidity: number;
  oiChange: number;
  total: number;
  notes: string[];
}

/** Short-side breakdown — earlyDrop mirrors earlyMove on the downside. */
export interface ShortScoreBreakdown {
  earlyDrop: number;
  volume: number;
  funding: number;
  liquidity: number;
  oiChange: number;
  total: number;
  notes: string[];
}

export interface MarketRegime {
  kind: RegimeKind;
  labelTh: string;
  btc24h: number;
  eth24h: number;
  btcShortMom: number | null;
  ethShortMom: number | null;
  updatedAt: string;
}

export interface ScreenRow {
  symbol: string;
  baseAsset: string;
  price: number;
  priceChangePercent: number;
  quoteVolume: number;
  lastFundingRate: number | null;
  markPrice: number | null;
  futuresVol: number;
  spotVol: number | null;
  futSpotRatio: number | null;
  hasSpot: boolean;
  oiChangePct: number | null;
  longShortRatio: number | null;
  /** Long / pump PatternScore */
  score: number;
  flags: Flag[];
  breakdown: ScoreBreakdown;
  entry: EntryHint;
  /** Short / dump score — independent of long score */
  shortScore: number;
  shortFlags: ShortFlag[];
  shortBreakdown: ShortScoreBreakdown;
  shortEntry: ShortEntryHint;
  catalystNote?: string;
  /** Act-now heuristic — null if not urgent */
  urgency: UrgencyKind | null;
  urgencyLabelTh: string | null;
  urgencyReasonTh: string | null;
  missRiskTh: string | null;
  /** Multi-timeframe align for the active urgency side / long bias */
  mtfAlign: MtfAlign | null;
  /** Quality A/B/C (long-oriented default; shortQualityGrade for short tab) */
  qualityGrade: QualityGrade;
  shortQualityGrade: QualityGrade;
  falsePatternRisk: boolean;
}

export interface NowAlertRow {
  symbol: string;
  baseAsset: string;
  price: number;
  priceChangePercent: number;
  quoteVolume: number;
  lastFundingRate: number | null;
  urgency: UrgencyKind;
  urgencyLabelTh: string;
  urgencyReasonTh: string;
  missRiskTh: string;
  score: number;
  shortScore: number;
  entryMode: string;
  shortEntryMode: string;
  flags: string[];
  shortFlags: string[];
  entryLow: number | null;
  entryHigh: number | null;
  qualityGrade: QualityGrade;
  mtfAlign: MtfAlign | null;
  falsePatternRisk: boolean;
}

export interface NowAlertsResponse {
  updatedAt: string;
  cacheTtlSec: number;
  disclaimerTh: string;
  regime: MarketRegime | null;
  long: NowAlertRow[];
  short: NowAlertRow[];
}


export interface ScreenResponse {
  updatedAt: string;
  cacheTtlSec: number;
  rows: ScreenRow[];
  meta: {
    futuresPairs: number;
    spotMatched: number;
    oiEnriched: number;
    mtfEnriched: number;
    warnings: string[];
    regime: MarketRegime | null;
  };
}

export interface FuturesTicker24hr {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
  volume: string;
}

export interface PremiumIndex {
  symbol: string;
  markPrice: string;
  lastFundingRate: string;
  nextFundingTime: number;
}

export interface SpotTicker24hr {
  symbol: string;
  quoteVolume: string;
  volume: string;
}

export interface OIHistPoint {
  symbol: string;
  sumOpenInterest: string;
  sumOpenInterestValue: string;
  timestamp: number;
}


export type LearnedOutcome = "win" | "loss" | "neutral";

/** Graded NOW alert outcome — shown in UI learned-cases section. */
export interface LearnedCase {
  id: string;
  alertId: string;
  symbol: string;
  side: "long" | "short";
  outcome: LearnedOutcome;
  movePct: number;
  /** Signed paper PnL % from the side's view (long=move, short=-move). */
  paperPnlPct?: number;
  horizon: "5m" | "15m" | "60m";
  noteTh: string;
  timestamp: string;
  priceAtSend: number;
  priceAtGrade: number;
  score: number | null;
  /** auto = evaluate script; manual = user ถูก/ผิด */
  source?: "auto" | "manual";
}
