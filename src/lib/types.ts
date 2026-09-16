/** Shared types for the pump pattern screener */

export type Flag =
  | "early_move"
  | "late_chase"
  | "neg_funding"
  | "thin_liquidity"
  | "no_spot"
  | "high_volume"
  | "oi_rising"
  | "short_squeeze_fuel"
  | "catalyst";

export type EntryMode =
  | "early_entry"
  | "wait_pullback"
  | "too_late"
  | "watch_only";

export interface EntryHint {
  mode: EntryMode;
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
  score: number;
  flags: Flag[];
  breakdown: ScoreBreakdown;
  catalystNote?: string;
  entry: EntryHint;
}

export interface ScreenResponse {
  updatedAt: string;
  cacheTtlSec: number;
  rows: ScreenRow[];
  meta: {
    futuresPairs: number;
    spotMatched: number;
    oiEnriched: number;
    warnings: string[];
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
