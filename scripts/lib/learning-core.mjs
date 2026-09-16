/**
 * Shared learning helpers for evaluate-alert-outcomes.mjs and (via spawn) API feedback.
 * Heuristic only — not financial advice.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "../..");
export const DATA_DIR = resolve(ROOT, "data");
export const ALERT_LOG_FILE = resolve(DATA_DIR, "alert-log.json");
export const LEARNED_CASES_FILE = resolve(DATA_DIR, "learned-cases.json");
export const LEARNED_WEIGHTS_FILE = resolve(DATA_DIR, "learned-weights.json");

export const ROLLING_N = 30;
export const MIN_GRADED_FOR_ADAPT = 5;

export const DEFAULTS = {
  nowLongMinScore: 55,
  nowShortMinScore: 50,
  nowLongPctMin: 5,
  nowLongPctMax: 18,
  nowShortPctMin: -18,
  nowShortPctMax: -5,
};

export function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(path, value) {
  ensureDataDir();
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Paper PnL from trader's side view: long = raw movePct, short = -movePct.
 */
export function paperPnlFromMove(side, movePct) {
  const m = Number(movePct);
  if (!Number.isFinite(m)) return 0;
  return side === "short" ? -m : m;
}

export function computeSideKnobs(winRate, graded, prev) {
  let scoreDelta = prev?.nowMinScoreDelta ?? 0;
  let bandDelta = prev?.nowPctBandDelta ?? 0;

  if (graded >= MIN_GRADED_FOR_ADAPT && winRate != null) {
    if (winRate < 0.4) {
      scoreDelta = 2;
      bandDelta = -2;
    } else if (winRate > 0.6) {
      scoreDelta = -2;
      bandDelta = 2;
    } else {
      scoreDelta = scoreDelta > 0 ? scoreDelta - 1 : scoreDelta < 0 ? scoreDelta + 1 : 0;
      bandDelta = bandDelta > 0 ? bandDelta - 1 : bandDelta < 0 ? bandDelta + 1 : 0;
    }
  }

  scoreDelta = clamp(scoreDelta, -2, 2);
  bandDelta = clamp(bandDelta, -2, 2);

  return {
    winRate,
    graded,
    nowMinScoreDelta: scoreDelta,
    nowPctBandDelta: bandDelta,
  };
}

export function buildWeights(cases, prevWeights) {
  const graded = cases
    .filter((c) => c.outcome === "win" || c.outcome === "loss")
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

  function sideRate(side) {
    const slice = graded.filter((c) => c.side === side).slice(0, ROLLING_N);
    const wins = slice.filter((c) => c.outcome === "win").length;
    const losses = slice.filter((c) => c.outcome === "loss").length;
    const n = wins + losses;
    return { winRate: n > 0 ? wins / n : null, graded: n };
  }

  const longS = sideRate("long");
  const shortS = sideRate("short");
  const long = computeSideKnobs(longS.winRate, longS.graded, prevWeights?.long);
  const short = computeSideKnobs(shortS.winRate, shortS.graded, prevWeights?.short);

  const nowLongMinScore = clamp(
    DEFAULTS.nowLongMinScore + long.nowMinScoreDelta,
    DEFAULTS.nowLongMinScore - 2,
    DEFAULTS.nowLongMinScore + 2
  );
  const nowShortMinScore = clamp(
    DEFAULTS.nowShortMinScore + short.nowMinScoreDelta,
    DEFAULTS.nowShortMinScore - 2,
    DEFAULTS.nowShortMinScore + 2
  );
  const nowLongPctMax = clamp(
    DEFAULTS.nowLongPctMax + long.nowPctBandDelta,
    DEFAULTS.nowLongPctMax - 2,
    DEFAULTS.nowLongPctMax + 2
  );
  const nowShortPctMin = clamp(
    DEFAULTS.nowShortPctMin - short.nowPctBandDelta,
    DEFAULTS.nowShortPctMin - 2,
    DEFAULTS.nowShortPctMin + 2
  );

  return {
    updatedAt: new Date().toISOString(),
    rollingN: ROLLING_N,
    long,
    short,
    effective: {
      nowLongMinScore,
      nowShortMinScore,
      nowLongPctMin: DEFAULTS.nowLongPctMin,
      nowLongPctMax,
      nowShortPctMin,
      nowShortPctMax: DEFAULTS.nowShortPctMax,
    },
  };
}

/** Rebuild learned-weights.json from current learned-cases.json */
export function refreshLearnedWeights() {
  const cases = readJson(LEARNED_CASES_FILE, []);
  const list = Array.isArray(cases) ? cases : [];
  const prev = readJson(LEARNED_WEIGHTS_FILE, null);
  const weights = buildWeights(list, prev);
  writeJson(LEARNED_WEIGHTS_FILE, weights);
  return weights;
}

export function loadAlertLog() {
  const raw = readJson(ALERT_LOG_FILE, { alerts: [] });
  const alerts = Array.isArray(raw?.alerts)
    ? raw.alerts
    : Array.isArray(raw)
      ? raw
      : [];
  return { alerts };
}

export function loadLearnedCases() {
  const raw = readJson(LEARNED_CASES_FILE, []);
  return Array.isArray(raw) ? raw : [];
}
