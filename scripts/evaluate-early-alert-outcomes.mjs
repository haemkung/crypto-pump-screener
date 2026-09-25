#!/usr/bin/env node
/**
 * Grade / sync early-tier alerts (data/early-alerts.json) into learned-cases.json.
 *
 * Early daemon already self-grades horizons into early-alerts; this script:
 *  1) syncs those win/loss/neutral outcomes into learned-cases (source: "early")
 *  2) grades any still-open horizons with the same thresholds as evaluate-alert-outcomes
 *  3) rebuilds learned-weights from the combined case list
 *
 * Does NOT wipe learned-cases. Heuristic only — not financial advice.
 *
 * Usage: node scripts/evaluate-early-alert-outcomes.mjs
 * Called from evaluate-alert-outcomes.mjs (before post-trade-coach).
 */
import { randomUUID } from "node:crypto";
import {
  ensureDataDir,
  writeJson,
  loadLearnedCases,
  buildWeights,
  paperPnlFromMove,
  readJson,
  LEARNED_CASES_FILE,
  LEARNED_WEIGHTS_FILE,
  DATA_DIR,
} from "./lib/learning-core.mjs";
import { resolve } from "node:path";

const EARLY_ALERTS_FILE = resolve(DATA_DIR, "early-alerts.json");
const MAX_CASES = 800;

const HORIZONS = {
  "5m": { ms: 5 * 60 * 1000, winPct: 0.8, lossPct: 0.8 },
  "15m": { ms: 15 * 60 * 1000, winPct: 1.5, lossPct: 1.5 },
  "60m": { ms: 60 * 60 * 1000, winPct: 3.0, lossPct: 3.0 },
};

const FAPI_HOSTS = [
  "https://www.binance.com",
  "https://fapi.binance.com",
];

function loadEarlyAlerts() {
  const raw = readJson(EARLY_ALERTS_FILE, { alerts: [] });
  const alerts = Array.isArray(raw?.alerts)
    ? raw.alerts
    : Array.isArray(raw)
      ? raw
      : [];
  return { ...raw, alerts };
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

function tierOf(alert) {
  if (alert.tier === "accumulation" || alert.tier === "distribution") return alert.tier;
  if (alert.type === "watch") return "watch";
  if (alert.type === "ignition") return "ignition";
  if (alert.type === "ignition_price_only") return "ignition_price_only";
  return String(alert.type || "early");
}

function labelThOf(alert) {
  const side = alert.side === "short" ? "short" : "long";
  if (alert.type === "watch" || alert.tier === "accumulation" || alert.tier === "distribution") {
    return side === "long" ? "กำลังสะสม" : "กำลังแจกของ";
  }
  if (alert.type === "ignition") {
    return side === "long" ? "เริ่มขยับ" : "เริ่มทุบ";
  }
  if (alert.type === "ignition_price_only") {
    return side === "long" ? "price-only (Long)" : "price-only (Short)";
  }
  return "ระยะต้น";
}

function noteTh(alert, outcome, movePct, horizon) {
  const sideTh = alert.side === "long" ? "Long" : "Short";
  const label = labelThOf(alert);
  const dir = movePct >= 0 ? "+" : "";
  if (outcome === "win") {
    return `Early ${label} ${sideTh} ถูก (${horizon}): ราคา ${dir}${movePct.toFixed(2)}% — heuristic ตรงทิศ`;
  }
  if (outcome === "loss") {
    return `Early ${label} ${sideTh} ผิด (${horizon}): ราคา ${dir}${movePct.toFixed(2)}% — ตรงข้ามทิศ`;
  }
  return `Early ${label} ${sideTh} เป็นกลาง (${horizon}): ราคา ${dir}${movePct.toFixed(2)}% — ยังไม่ถึงเกณฑ์`;
}


function factorKeysOf(alert) {
  return Array.isArray(alert.factors)
    ? alert.factors.map((f) => f?.key).filter(Boolean)
    : [];
}

function aiSlimOf(alert) {
  const ai = alert.ai;
  if (!ai || typeof ai !== "object") return null;
  return {
    action: ai.action || null,
    score: Number.isFinite(ai.score) ? ai.score : null,
    reasonTh: ai.reasonTh || null,
    model: ai.model || null,
    skipped: !!ai.skipped,
  };
}

function tradeGradeOf(alert) {
  if (alert.trade && typeof alert.trade === "object") {
    if (alert.trade.tp1 === true) return "tp1";
    if (alert.trade.r != null && Number(alert.trade.r) < 0) return "sl";
    if (alert.trade.complete === false) return "open";
    if (alert.trade.complete === true && !alert.trade.tp1) return "timeout";
  }
  if (alert.big?.result === "win" || alert.big?.result === "loss") return `big_${alert.big.result}`;
  if (alert.small?.result === "win" || alert.small?.result === "loss") return `small_${alert.small.result}`;
  return null;
}

function enrichCaseFields(alert) {
  const keys = factorKeysOf(alert);
  const ai = aiSlimOf(alert);
  return {
    factorKeys: keys,
    factorCount: alert.factorCount ?? keys.length,
    aiAction: ai?.action || null,
    aiScore: ai?.score ?? null,
    aiReasonTh: ai?.reasonTh || null,
    aiSkipped: ai ? !!ai.skipped : null,
    tradeGrade: tradeGradeOf(alert),
    delivered: !!alert.delivered,
    suppressed: alert.suppressed || null,
  };
}

function ensureOutcomes(alert) {
  if (!alert.outcomes || typeof alert.outcomes !== "object") {
    alert.outcomes = { "5m": null, "15m": null, "60m": null };
    return;
  }
  for (const h of Object.keys(HORIZONS)) {
    if (!(h in alert.outcomes)) alert.outcomes[h] = null;
  }
}

function isGradableOutcome(o) {
  return o === "win" || o === "loss" || o === "neutral";
}

async function main() {
  ensureDataDir();
  const early = loadEarlyAlerts();
  const cases = loadLearnedCases();
  const existingCaseKeys = new Set(
    cases.map((c) => `${c.alertId}|${c.horizon}`)
  );

  const now = Date.now();
  const pendingFetch = [];
  let syncedExisting = 0;
  let awaitingHorizon = 0;
  let skippedMissed = 0;

  // Pass 1: sync already-graded early outcomes (from daemon) into learned-cases
  for (const alert of early.alerts) {
    if (!alert?.id || !alert.symbol || !alert.sentAt || !(alert.price > 0)) continue;
    const side = alert.side === "short" ? "short" : "long";
    alert.side = side;
    ensureOutcomes(alert);
    const sentMs = Date.parse(alert.sentAt);
    if (!Number.isFinite(sentMs)) continue;

    for (const [horizon, cfg] of Object.entries(HORIZONS)) {
      const key = `${alert.id}|${horizon}`;
      if (existingCaseKeys.has(key)) continue;

      const existing = alert.outcomes[horizon];
      if (existing === "missed") {
        skippedMissed++;
        continue;
      }
      if (isGradableOutcome(existing)) {
        const movePct =
          alert.moves && Number.isFinite(alert.moves[horizon])
            ? Number(alert.moves[horizon])
            : null;
        // Without a stored move, still record outcome with 0 move (rare); prefer re-grade via fetch
        if (movePct == null) {
          if (now - sentMs >= cfg.ms) pendingFetch.push({ alert, horizon, cfg });
          else awaitingHorizon++;
          continue;
        }
        const roundedMove = Math.round(movePct * 100) / 100;
        const paperPnlPct =
          Math.round(paperPnlFromMove(side, roundedMove) * 100) / 100;
        const priceAtGrade =
          alert.price * (1 + roundedMove / 100);
        cases.push({
          id: randomUUID(),
          alertId: alert.id,
          symbol: alert.symbol,
          side,
          outcome: existing,
          movePct: roundedMove,
          paperPnlPct,
          horizon,
          noteTh: noteTh(alert, existing, roundedMove, horizon),
          timestamp: new Date().toISOString(),
          priceAtSend: alert.price,
          priceAtGrade,
          score: alert.factorCount ?? alert.directional ?? null,
          source: "early",
          tier: tierOf(alert),
          labelTh: labelThOf(alert),
          earlyType: alert.type || null,
          ...enrichCaseFields(alert),
        });
        existingCaseKeys.add(key);
        syncedExisting++;
        continue;
      }

      // null / unknown — schedule price grade if horizon elapsed
      if (now - sentMs < cfg.ms) {
        awaitingHorizon++;
        continue;
      }
      pendingFetch.push({ alert, horizon, cfg });
    }
  }

  const symbols = [...new Set(pendingFetch.map((p) => p.alert.symbol))];
  let priceMap = new Map();
  if (symbols.length > 0) {
    try {
      priceMap = await fetchPriceMap(symbols);
    } catch (e) {
      console.error("early price fetch failed:", String(e));
      // continue with sync-only results
    }
  }

  let gradedNew = 0;
  const gradedLines = [];
  let skippedNoPrice = 0;
  let earlyLogDirty = false;

  for (const { alert, horizon, cfg } of pendingFetch) {
    const key = `${alert.id}|${horizon}`;
    if (existingCaseKeys.has(key)) continue;
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
    (alert.moves ||= {})[horizon] = roundedMove;
    earlyLogDirty = true;

    cases.push({
      id: randomUUID(),
      alertId: alert.id,
      symbol: alert.symbol,
      side: alert.side,
      outcome,
      movePct: roundedMove,
      paperPnlPct,
      horizon,
      noteTh: noteTh(alert, outcome, roundedMove, horizon),
      timestamp: new Date().toISOString(),
      priceAtSend: alert.price,
      priceAtGrade: priceNow,
      score: alert.factorCount ?? alert.directional ?? null,
      source: "early",
      tier: tierOf(alert),
      labelTh: labelThOf(alert),
      earlyType: alert.type || null,
      ...enrichCaseFields(alert),
    });
    existingCaseKeys.add(key);
    gradedNew++;
    gradedLines.push(
      `  ${alert.symbol} ${alert.side} ${tierOf(alert)} ${horizon} → ${outcome} move=${roundedMove >= 0 ? "+" : ""}${roundedMove}%`
    );
  }

  const trimmedCases = cases.length > MAX_CASES ? cases.slice(-MAX_CASES) : cases;

  // Backfill factors/AI onto existing early cases (join by alertId) so learner + AI see them
  const alertById = new Map(early.alerts.filter((a) => a?.id).map((a) => [a.id, a]));
  let backfilled = 0;
  for (const c of trimmedCases) {
    if (c.source !== "early" || !c.alertId) continue;
    if (Array.isArray(c.factorKeys) && c.factorKeys.length && c.aiAction != null) continue;
    const alert = alertById.get(c.alertId);
    if (!alert) continue;
    const extra = enrichCaseFields(alert);
    let changed = false;
    for (const [k, v] of Object.entries(extra)) {
      if (c[k] == null || (k === "factorKeys" && (!Array.isArray(c.factorKeys) || !c.factorKeys.length))) {
        c[k] = v;
        changed = true;
      }
    }
    if (changed) backfilled++;
  }

  writeJson(LEARNED_CASES_FILE, trimmedCases);
  if (earlyLogDirty) writeJson(EARLY_ALERTS_FILE, early);

  const prevWeights = readJson(LEARNED_WEIGHTS_FILE, null);
  const weights = buildWeights(trimmedCases, prevWeights);
  writeJson(LEARNED_WEIGHTS_FILE, weights);

  const earlyCases = trimmedCases.filter((c) => c.source === "early");
  const earlyGraded = earlyCases.filter(
    (c) => c.outcome === "win" || c.outcome === "loss"
  );

  console.log("=== evaluate-early-alert-outcomes ===");
  console.log(
    `early_alerts=${early.alerts.length} synced_existing=${syncedExisting} graded_new=${gradedNew} awaiting_horizon=${awaitingHorizon} skipped_missed=${skippedMissed} skipped_no_price=${skippedNoPrice}`
  );
  console.log(
    `cases_total=${trimmedCases.length} early_cases=${earlyCases.length} early_winloss=${earlyGraded.length} backfilled_enrich=${backfilled}`
  );
  if (gradedLines.length) {
    console.log("graded:");
    for (const line of gradedLines.slice(0, 40)) console.log(line);
    if (gradedLines.length > 40) console.log(`  … +${gradedLines.length - 40} more`);
  } else {
    console.log("graded: (none this run)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
