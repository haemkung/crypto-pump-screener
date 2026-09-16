/**
 * Adaptive NOW thresholds from graded alert outcomes.
 * Reads data/learned-weights.json if present; otherwise defaults.
 * Brief in-process cache so buildScreen does not hit disk per row.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  NOW_LONG_MIN_SCORE,
  NOW_SHORT_MIN_SCORE,
  NOW_LONG_PCT_MIN,
  NOW_LONG_PCT_MAX,
  NOW_SHORT_PCT_MIN,
  NOW_SHORT_PCT_MAX,
} from "./urgencyDefaults";

export interface LearnedSideKnobs {
  winRate: number | null;
  graded: number;
  nowMinScoreDelta: number;
  /** Long: delta on NOW_LONG_PCT_MAX; Short: delta on NOW_SHORT_PCT_MIN (negative = tighter) */
  nowPctBandDelta: number;
}

export interface LearnedWeightsFile {
  updatedAt: string | null;
  rollingN: number;
  long: LearnedSideKnobs;
  short: LearnedSideKnobs;
  effective: {
    nowLongMinScore: number;
    nowShortMinScore: number;
    nowLongPctMin: number;
    nowLongPctMax: number;
    nowShortPctMin: number;
    nowShortPctMax: number;
  };
}

export interface NowThresholds {
  longMinScore: number;
  shortMinScore: number;
  longPctMin: number;
  longPctMax: number;
  shortPctMin: number;
  shortPctMax: number;
  source: "defaults" | "learned";
  learned: LearnedWeightsFile | null;
}

const WEIGHTS_PATH = resolve(process.cwd(), "data", "learned-weights.json");
const CACHE_TTL_MS = 15_000;

let cache: { at: number; thresholds: NowThresholds } | null = null;

function defaultKnobs(): LearnedSideKnobs {
  return {
    winRate: null,
    graded: 0,
    nowMinScoreDelta: 0,
    nowPctBandDelta: 0,
  };
}

export function defaultLearnedWeights(): LearnedWeightsFile {
  return {
    updatedAt: null,
    rollingN: 30,
    long: defaultKnobs(),
    short: defaultKnobs(),
    effective: {
      nowLongMinScore: NOW_LONG_MIN_SCORE,
      nowShortMinScore: NOW_SHORT_MIN_SCORE,
      nowLongPctMin: NOW_LONG_PCT_MIN,
      nowLongPctMax: NOW_LONG_PCT_MAX,
      nowShortPctMin: NOW_SHORT_PCT_MIN,
      nowShortPctMax: NOW_SHORT_PCT_MAX,
    },
  };
}

function applyEffective(file: LearnedWeightsFile): NowThresholds {
  const longScore = NOW_LONG_MIN_SCORE + (file.long?.nowMinScoreDelta ?? 0);
  const shortScore = NOW_SHORT_MIN_SCORE + (file.short?.nowMinScoreDelta ?? 0);
  const longPctMax = NOW_LONG_PCT_MAX + (file.long?.nowPctBandDelta ?? 0);
  // For short, band is [pctMin, pctMax]; tightening means raising pctMin toward 0 (e.g. -18 → -16)
  const shortPctMin = NOW_SHORT_PCT_MIN - (file.short?.nowPctBandDelta ?? 0);

  return {
    longMinScore: clamp(longScore, NOW_LONG_MIN_SCORE - 2, NOW_LONG_MIN_SCORE + 2),
    shortMinScore: clamp(shortScore, NOW_SHORT_MIN_SCORE - 2, NOW_SHORT_MIN_SCORE + 2),
    longPctMin: NOW_LONG_PCT_MIN,
    longPctMax: clamp(longPctMax, NOW_LONG_PCT_MAX - 2, NOW_LONG_PCT_MAX + 2),
    shortPctMin: clamp(shortPctMin, NOW_SHORT_PCT_MIN - 2, NOW_SHORT_PCT_MIN + 2),
    shortPctMax: NOW_SHORT_PCT_MAX,
    source: "learned",
    learned: file,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function readWeightsFile(): LearnedWeightsFile | null {
  if (!existsSync(WEIGHTS_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(WEIGHTS_PATH, "utf8"));
    if (!raw || typeof raw !== "object") return null;
    const base = defaultLearnedWeights();
    return {
      ...base,
      ...raw,
      long: { ...base.long, ...(raw.long || {}) },
      short: { ...base.short, ...(raw.short || {}) },
      effective: { ...base.effective, ...(raw.effective || {}) },
    };
  } catch {
    return null;
  }
}

/** Effective NOW thresholds — defaults unless learned-weights.json exists. */
export function getNowThresholds(force = false): NowThresholds {
  const now = Date.now();
  if (!force && cache && now - cache.at < CACHE_TTL_MS) return cache.thresholds;

  const file = readWeightsFile();
  const thresholds: NowThresholds = file
    ? applyEffective(file)
    : {
        longMinScore: NOW_LONG_MIN_SCORE,
        shortMinScore: NOW_SHORT_MIN_SCORE,
        longPctMin: NOW_LONG_PCT_MIN,
        longPctMax: NOW_LONG_PCT_MAX,
        shortPctMin: NOW_SHORT_PCT_MIN,
        shortPctMax: NOW_SHORT_PCT_MAX,
        source: "defaults",
        learned: null,
      };

  cache = { at: now, thresholds };
  return thresholds;
}

export function clearLearnedWeightsCache(): void {
  cache = null;
}
