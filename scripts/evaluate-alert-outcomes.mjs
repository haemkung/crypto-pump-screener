#!/usr/bin/env node
/**
 * Grade open NOW alerts in data/alert-log.json at 5m / 15m / 60m horizons,
 * append win/loss/neutral cases to data/learned-cases.json, and nudge
 * data/learned-weights.json from rolling accuracy.
 *
 * Primary learning path is automatic (price-based) — manual ถูก/ผิด is optional.
 * Heuristic only — not financial advice / not a trading system.
 *
 * Usage: node scripts/evaluate-alert-outcomes.mjs
 */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  ensureDataDir,
  writeJson,
  loadAlertLog,
  loadLearnedCases,
  buildWeights,
  paperPnlFromMove,
  readJson,
  ALERT_LOG_FILE,
  LEARNED_CASES_FILE,
  LEARNED_WEIGHTS_FILE,
} from "./lib/learning-core.mjs";

const HORIZONS = {
  "5m": { ms: 5 * 60 * 1000, winPct: 0.8, lossPct: 0.8 },
  "15m": { ms: 15 * 60 * 1000, winPct: 1.5, lossPct: 1.5 },
  "60m": { ms: 60 * 60 * 1000, winPct: 3.0, lossPct: 3.0 },
};

const EMPTY_OUTCOMES = () => ({ "5m": null, "15m": null, "60m": null });

const FAPI_HOSTS = [
  "https://www.binance.com",
  "https://fapi.binance.com",
];

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

function gradeMove(side, movePct, winPct, lossPct) {
  if (side === "long") {
    if (movePct >= winPct) return "win";
    if (movePct <= -lossPct) return "loss";
    return "neutral";
  }
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

function ensureOutcomes(alert) {
  if (!alert.outcomes || typeof alert.outcomes !== "object") {
    alert.outcomes = EMPTY_OUTCOMES();
    return;
  }
  for (const h of Object.keys(HORIZONS)) {
    if (!(h in alert.outcomes)) alert.outcomes[h] = null;
  }
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
  let awaitingHorizon = 0;

  for (const alert of log.alerts) {
    if (!alert?.id || !alert.symbol || !alert.sentAt || !alert.price) continue;
    const sentMs = Date.parse(alert.sentAt);
    if (!Number.isFinite(sentMs)) continue;
    ensureOutcomes(alert);
    for (const [horizon, cfg] of Object.entries(HORIZONS)) {
      if (alert.outcomes[horizon] != null) continue;
      if (now - sentMs < cfg.ms) {
        awaitingHorizon++;
        continue;
      }
      const key = `${alert.id}|${horizon}`;
      if (existingCaseKeys.has(key)) {
        const found = cases.find(
          (c) => c.alertId === alert.id && c.horizon === horizon
        );
        if (found) alert.outcomes[horizon] = found.outcome;
        continue;
      }
      pending.push({ alert, horizon, cfg, ageMin: (now - sentMs) / 60000 });
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
  const gradedLines = [];
  let skippedNoPrice = 0;

  for (const { alert, horizon, cfg, ageMin } of pending) {
    const priceNow = priceMap.get(alert.symbol);
    if (priceNow == null || !Number.isFinite(priceNow) || alert.price <= 0) {
      skippedNoPrice++;
      continue;
    }
    const movePct = ((priceNow - alert.price) / alert.price) * 100;
    const outcome = gradeMove(alert.side, movePct, cfg.winPct, cfg.lossPct);
    const roundedMove = Math.round(movePct * 100) / 100;
    const paperPnlPct =
      Math.round(paperPnlFromMove(alert.side, roundedMove) * 100) / 100;
    alert.outcomes[horizon] = outcome;
    if (!alert.paperPnl) alert.paperPnl = {};
    alert.paperPnl[horizon] = paperPnlPct;

    const learned = {
      id: randomUUID(),
      alertId: alert.id,
      symbol: alert.symbol,
      side: alert.side,
      outcome,
      movePct: roundedMove,
      paperPnlPct,
      horizon,
      noteTh: noteTh(alert.side, outcome, movePct, horizon),
      timestamp: new Date().toISOString(),
      priceAtSend: alert.price,
      priceAtGrade: priceNow,
      score: alert.score ?? null,
      source: "auto",
    };
    cases.push(learned);
    existingCaseKeys.add(`${alert.id}|${horizon}`);
    gradedNew++;
    gradedLines.push(
      `  ${alert.symbol} ${alert.side} ${horizon} → ${outcome} move=${roundedMove >= 0 ? "+" : ""}${roundedMove}% paper=${paperPnlPct >= 0 ? "+" : ""}${paperPnlPct}% age=${ageMin.toFixed(1)}m`
    );
  }

  const trimmedCases = cases.length > 800 ? cases.slice(-800) : cases;
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

  console.log("=== evaluate-alert-outcomes ===");
  console.log(
    `pending_eligible=${pending.length} graded_new=${gradedNew} awaiting_horizon=${awaitingHorizon} skipped_no_price=${skippedNoPrice}`
  );
  console.log(
    `cases_total=${trimmedCases.length} long_wr=${longWr}(${weights.long.graded}) short_wr=${shortWr}(${weights.short.graded})`
  );
  console.log(
    `weights long_score=${weights.effective.nowLongMinScore} short_score=${weights.effective.nowShortMinScore}`
  );
  if (gradedLines.length) {
    console.log("graded:");
    for (const line of gradedLines) console.log(line);
  } else {
    console.log("graded: (none this run)");
  }
}

const __evalDir = dirname(fileURLToPath(import.meta.url));

main()
  .then(() => {
    // Early-tier learning (ระยะต้น) → learned-cases, then coach on combined set
    for (const script of ["evaluate-early-alert-outcomes.mjs", "post-trade-coach.mjs"]) {
      const r = spawnSync(process.execPath, [resolve(__evalDir, script)], {
        encoding: "utf8",
      });
      if (r.stdout) process.stdout.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
      if (r.status && r.status !== 0) {
        console.error(`${script} exited ${r.status}`);
      }
    }
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
