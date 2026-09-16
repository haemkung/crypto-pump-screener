#!/usr/bin/env node
/**
 * Grade open NOW alerts in data/alert-log.json at 15m and 60m horizons,
 * append win/loss cases to data/learned-cases.json, and nudge
 * data/learned-weights.json from rolling accuracy.
 *
 * Heuristic only — not financial advice / not a trading system.
 *
 * Usage: node scripts/evaluate-alert-outcomes.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DATA_DIR = resolve(ROOT, "data");
const ALERT_LOG_FILE = resolve(DATA_DIR, "alert-log.json");
const LEARNED_CASES_FILE = resolve(DATA_DIR, "learned-cases.json");
const LEARNED_WEIGHTS_FILE = resolve(DATA_DIR, "learned-weights.json");

const HORIZONS = {
  "15m": { ms: 15 * 60 * 1000, winPct: 1.5, lossPct: 1.5 },
  "60m": { ms: 60 * 60 * 1000, winPct: 3.0, lossPct: 3.0 },
};

const ROLLING_N = 30;
const MIN_GRADED_FOR_ADAPT = 5;

const DEFAULTS = {
  nowLongMinScore: 55,
  nowShortMinScore: 50,
  nowLongPctMin: 5,
  nowLongPctMax: 18,
  nowShortPctMin: -18,
  nowShortPctMax: -5,
};

const FAPI_HOSTS = [
  "https://www.binance.com",
  "https://fapi.binance.com",
];

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  ensureDataDir();
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function loadAlertLog() {
  const raw = readJson(ALERT_LOG_FILE, { alerts: [] });
  const alerts = Array.isArray(raw?.alerts)
    ? raw.alerts
    : Array.isArray(raw)
      ? raw
      : [];
  return { alerts };
}

function loadLearnedCases() {
  const raw = readJson(LEARNED_CASES_FILE, []);
  return Array.isArray(raw) ? raw : [];
}

async function fetchJsonFromHosts(path) {
  let lastErr;
  for (const host of FAPI_HOSTS) {
    const url = `${host}${path}`;
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status} ${url}`);
        if ([418, 429, 451, 403, 502, 503].includes(res.status)) continue;
        throw lastErr;
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Bulk last prices for USDT-M perps. */
async function fetchPriceMap(symbols) {
  const needed = new Set(symbols);
  if (needed.size === 0) return new Map();
  const tickers = await fetchJsonFromHosts("/fapi/v1/ticker/price");
  const map = new Map();
  if (Array.isArray(tickers)) {
    for (const t of tickers) {
      if (needed.has(t.symbol)) map.set(t.symbol, Number(t.price));
    }
  }
  return map;
}

/**
 * Grade move for one side/horizon.
 * Long: win if +winPct, loss if −lossPct; Short inverted.
 */
function gradeMove(side, movePct, winPct, lossPct) {
  if (side === "long") {
    if (movePct >= winPct) return "win";
    if (movePct <= -lossPct) return "loss";
    return "neutral";
  }
  // short: price drop is win
  if (movePct <= -winPct) return "win";
  if (movePct >= lossPct) return "loss";
  return "neutral";
}

function noteTh(side, outcome, movePct, horizon) {
  const dir = movePct >= 0 ? "+" : "";
  const sideTh = side === "long" ? "Long" : "Short";
  if (outcome === "win") {
    return `${sideTh} ถูก (${horizon}): ราคา ${dir}${movePct.toFixed(2)}% — heuristic ตรงทิศ`;
  }
  if (outcome === "loss") {
    return `${sideTh} ผิด (${horizon}): ราคา ${dir}${movePct.toFixed(2)}% — ตรงข้ามทิศ`;
  }
  return `${sideTh} เป็นกลาง (${horizon}): ราคา ${dir}${movePct.toFixed(2)}% — ยังไม่ถึงเกณฑ์`;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * From rolling win rates, set score/band deltas (cap ±2).
 * <40% tighten; >60% loosen; else decay toward 0.
 */
function computeSideKnobs(winRate, graded, prev) {
  let scoreDelta = prev?.nowMinScoreDelta ?? 0;
  let bandDelta = prev?.nowPctBandDelta ?? 0;

  if (graded >= MIN_GRADED_FOR_ADAPT && winRate != null) {
    if (winRate < 0.4) {
      scoreDelta = 2; // raise min score
      bandDelta = -2; // tighten 24h band
    } else if (winRate > 0.6) {
      scoreDelta = -2; // loosen
      bandDelta = 2;
    } else {
      // mid band — ease back toward defaults
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

function buildWeights(cases, prevWeights) {
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
  // Short: positive bandDelta loosens (more negative min); negative tightens
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

async function main() {
  ensureDataDir();
  const log = loadAlertLog();
  const cases = loadLearnedCases();
  const existingCaseKeys = new Set(
    cases.map((c) => `${c.alertId}|${c.horizon}`)
  );

  const now = Date.now();
  const pending = [];

  for (const alert of log.alerts) {
    if (!alert?.id || !alert.symbol || !alert.sentAt || !alert.price) continue;
    const sentMs = Date.parse(alert.sentAt);
    if (!Number.isFinite(sentMs)) continue;
    if (!alert.outcomes || typeof alert.outcomes !== "object") {
      alert.outcomes = { "15m": null, "60m": null };
    }
    for (const [horizon, cfg] of Object.entries(HORIZONS)) {
      if (alert.outcomes[horizon] != null) continue;
      if (now - sentMs < cfg.ms) continue;
      const key = `${alert.id}|${horizon}`;
      if (existingCaseKeys.has(key)) {
        // already in learned-cases; mark log graded
        const found = cases.find(
          (c) => c.alertId === alert.id && c.horizon === horizon
        );
        if (found) alert.outcomes[horizon] = found.outcome;
        continue;
      }
      pending.push({ alert, horizon, cfg });
    }
  }

  const symbols = [...new Set(pending.map((p) => p.alert.symbol))];
  let priceMap = new Map();
  if (symbols.length > 0) {
    try {
      priceMap = await fetchPriceMap(symbols);
    } catch (e) {
      console.error("price fetch failed:", String(e));
      process.exit(1);
    }
  }

  let gradedNew = 0;
  for (const { alert, horizon, cfg } of pending) {
    const priceNow = priceMap.get(alert.symbol);
    if (priceNow == null || !Number.isFinite(priceNow) || alert.price <= 0) {
      continue;
    }
    const movePct = ((priceNow - alert.price) / alert.price) * 100;
    const outcome = gradeMove(alert.side, movePct, cfg.winPct, cfg.lossPct);
    alert.outcomes[horizon] = outcome;

    const learned = {
      id: randomUUID(),
      alertId: alert.id,
      symbol: alert.symbol,
      side: alert.side,
      outcome,
      movePct: Math.round(movePct * 100) / 100,
      horizon,
      noteTh: noteTh(alert.side, outcome, movePct, horizon),
      timestamp: new Date().toISOString(),
      priceAtSend: alert.price,
      priceAtGrade: priceNow,
      score: alert.score ?? null,
    };
    cases.push(learned);
    existingCaseKeys.add(`${alert.id}|${horizon}`);
    gradedNew++;
  }

  // Cap learned cases
  const trimmedCases = cases.length > 400 ? cases.slice(-400) : cases;
  writeJson(LEARNED_CASES_FILE, trimmedCases);
  writeJson(ALERT_LOG_FILE, log);

  const prevWeights = readJson(LEARNED_WEIGHTS_FILE, null);
  const weights = buildWeights(trimmedCases, prevWeights);
  writeJson(LEARNED_WEIGHTS_FILE, weights);

  const longWr =
    weights.long.winRate != null
      ? (weights.long.winRate * 100).toFixed(1) + "%"
      : "n/a";
  const shortWr =
    weights.short.winRate != null
      ? (weights.short.winRate * 100).toFixed(1) + "%"
      : "n/a";

  console.log(
    `graded_new=${gradedNew} cases_total=${trimmedCases.length} ` +
      `long_wr=${longWr}(${weights.long.graded}) short_wr=${shortWr}(${weights.short.graded}) ` +
      `long_score=${weights.effective.nowLongMinScore} short_score=${weights.effective.nowShortMinScore}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
