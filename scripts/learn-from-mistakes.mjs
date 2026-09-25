#!/usr/bin/env node
/**
 * Aggregate early-alert win/loss patterns → learning-insights.json + early-learned-bias.json.
 * Feeds Coach UI and AI realtime review (few-shot). Conservative soft bias only.
 * Heuristic — not financial advice.
 *
 * Usage: node scripts/learn-from-mistakes.mjs
 * Invoked at end of evaluate-alert-outcomes.mjs (after post-trade-coach).
 */
import { resolve } from "node:path";
import {
  ensureDataDir,
  writeJson,
  readJson,
  loadLearnedCases,
  DATA_DIR,
  clamp,
} from "./lib/learning-core.mjs";

const EARLY_ALERTS_FILE = resolve(DATA_DIR, "early-alerts.json");
const INSIGHTS_FILE = resolve(DATA_DIR, "learning-insights.json");
const BIAS_FILE = resolve(DATA_DIR, "early-learned-bias.json");
const COACH_FILE = resolve(DATA_DIR, "coach-notes.json");

const MIN_PATTERN_N = 2;
const ROLLING_ALERTS = 80;
const MAX_FEWSHOT = 8;
const MAX_MISTAKES = 8;
const MAX_WINS = 5;
const MIN_FACTORS_FLOOR = 3;
const MAX_SL_PCT = 3;

function loadEarly() {
  const raw = readJson(EARLY_ALERTS_FILE, { alerts: [] });
  return Array.isArray(raw?.alerts) ? raw.alerts : [];
}

function factorKeys(a) {
  if (Array.isArray(a.factorKeys) && a.factorKeys.length) {
    return [...new Set(a.factorKeys.filter(Boolean))].sort();
  }
  if (Array.isArray(a.factors)) {
    return [...new Set(a.factors.map((f) => f?.key).filter(Boolean))].sort();
  }
  return [];
}

function patternKey(side, keys) {
  return `${side}|${keys.join("+")}`;
}

/** Prefer 15m, else 60m, else 5m win/loss; else big/small. */
function primaryOutcome(a) {
  const outs = a.outcomes || {};
  for (const h of ["15m", "60m", "5m"]) {
    if (outs[h] === "win" || outs[h] === "loss") return { outcome: outs[h], horizon: h };
  }
  if (a.trade?.tp1 === true) return { outcome: "win", horizon: "tp1" };
  if (a.trade && a.trade.r != null && Number(a.trade.r) < 0) {
    return { outcome: "loss", horizon: "sl" };
  }
  if (a.big?.result === "win" || a.big?.result === "loss") {
    return { outcome: a.big.result, horizon: "big" };
  }
  if (a.small?.result === "win" || a.small?.result === "loss") {
    return { outcome: a.small.result, horizon: "small" };
  }
  return null;
}

function fmtWr(wr) {
  if (wr == null) return "—";
  return `${(wr * 100).toFixed(0)}%`;
}

function buildInsights(alerts, cases) {
  // Prefer confluence-era alerts (≥3 factors); include delivered + suppressed for learning
  const usable = alerts
    .filter((a) => a && a.symbol && a.side)
    .filter((a) => {
      const n = a.factorCount ?? factorKeys(a).length;
      return n >= MIN_FACTORS_FLOOR || a.type === "watch" || a.type === "ignition";
    })
    .sort((a, b) => String(a.sentAt || "").localeCompare(String(b.sentAt || "")))
    .slice(-ROLLING_ALERTS);

  const gradedAlerts = [];
  for (const a of usable) {
    const po = primaryOutcome(a);
    if (!po) continue;
    const keys = factorKeys(a);
    gradedAlerts.push({
      id: a.id,
      symbol: a.symbol,
      side: a.side === "short" ? "short" : "long",
      type: a.type || null,
      tier: a.tier || a.type || null,
      outcome: po.outcome,
      horizon: po.horizon,
      factorKeys: keys,
      factorCount: a.factorCount ?? keys.length,
      aiAction: a.ai?.action || null,
      aiScore: a.ai?.score ?? null,
      aiReasonTh: a.ai?.reasonTh || null,
      delivered: !!a.delivered,
      suppressed: a.suppressed || null,
      sentAt: a.sentAt,
      movePct:
        a.moves?.[po.horizon] ??
        a.moves?.["15m"] ??
        a.moves?.["60m"] ??
        a.movePct ??
        null,
    });
  }

  // Also fold enriched learned-cases (early win/loss) when alert missing from slice
  const seen = new Set(gradedAlerts.map((g) => g.id));
  const earlyCases = cases
    .filter((c) => c.source === "early" && (c.outcome === "win" || c.outcome === "loss"))
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
    .slice(0, 120);
  for (const c of earlyCases) {
    if (c.alertId && seen.has(c.alertId)) continue;
    const keys = Array.isArray(c.factorKeys) ? [...c.factorKeys].filter(Boolean).sort() : [];
    if (keys.length < 1 && (c.factorCount || 0) < MIN_FACTORS_FLOOR) continue;
    gradedAlerts.push({
      id: c.alertId || c.id,
      symbol: c.symbol,
      side: c.side === "short" ? "short" : "long",
      type: c.earlyType || null,
      tier: c.tier || null,
      outcome: c.outcome,
      horizon: c.horizon || "15m",
      factorKeys: keys,
      factorCount: c.factorCount ?? keys.length,
      aiAction: c.aiAction || null,
      aiScore: c.aiScore ?? null,
      aiReasonTh: c.aiReasonTh || null,
      delivered: c.delivered ?? null,
      suppressed: c.suppressed || null,
      sentAt: c.timestamp,
      movePct: c.movePct ?? null,
    });
    if (c.alertId) seen.add(c.alertId);
  }

  const wins = gradedAlerts.filter((g) => g.outcome === "win");
  const losses = gradedAlerts.filter((g) => g.outcome === "loss");
  const gradedN = wins.length + losses.length;
  const winRate = gradedN > 0 ? wins.length / gradedN : null;

  // Factor-combo tallies (require ≥2 keys for pattern; single-key only for caution list)
  const combo = new Map();
  for (const g of gradedAlerts) {
    const keys = g.factorKeys;
    if (keys.length < 2) continue;
    const pk = patternKey(g.side, keys);
    let row = combo.get(pk);
    if (!row) {
      row = {
        side: g.side,
        factorKeys: keys,
        wins: 0,
        losses: 0,
        aiSendLoss: 0,
        aiBoostLoss: 0,
        aiVetoWin: 0,
        samples: [],
      };
      combo.set(pk, row);
    }
    if (g.outcome === "win") row.wins++;
    else row.losses++;
    if (g.outcome === "loss" && g.aiAction === "send") row.aiSendLoss++;
    if (g.outcome === "loss" && g.aiAction === "boost") row.aiBoostLoss++;
    if (g.outcome === "win" && g.aiAction === "veto") row.aiVetoWin++;
    if (row.samples.length < 3) {
      row.samples.push({
        symbol: g.symbol,
        outcome: g.outcome,
        aiAction: g.aiAction,
        horizon: g.horizon,
      });
    }
  }

  const combos = [...combo.values()].map((r) => {
    const n = r.wins + r.losses;
    return {
      ...r,
      n,
      winRate: n > 0 ? r.wins / n : null,
      lossRate: n > 0 ? r.losses / n : null,
    };
  });

  const losingPatterns = combos
    .filter((c) => c.losses >= MIN_PATTERN_N && (c.winRate == null || c.winRate <= 0.4))
    .sort((a, b) => b.losses - a.losses || (a.winRate ?? 1) - (b.winRate ?? 1))
    .slice(0, MAX_MISTAKES);

  const winningPatterns = combos
    .filter((c) => c.wins >= MIN_PATTERN_N && (c.winRate == null || c.winRate >= 0.6))
    .sort((a, b) => b.wins - a.wins || (b.winRate ?? 0) - (a.winRate ?? 0))
    .slice(0, MAX_WINS);

  // AI action stats
  const aiStats = { send: { w: 0, l: 0 }, boost: { w: 0, l: 0 }, veto: { w: 0, l: 0 } };
  for (const g of gradedAlerts) {
    const act = g.aiAction;
    if (!act || !aiStats[act]) continue;
    if (g.outcome === "win") aiStats[act].w++;
    else if (g.outcome === "loss") aiStats[act].l++;
  }

  const mistakes = losingPatterns.map((p) => {
    const factors = p.factorKeys.join("+");
    const tip =
      p.aiBoostLoss > 0
        ? "AI เคยบูสต์แล้วพลาด — ระวัง boost ในแพทเทิร์นนี้"
        : p.aiSendLoss > 0
          ? "AI ส่งแล้วพลาดซ้ำ — พิจารณา veto เมื่อสัญญาณคล้าย"
          : "แพทเทิร์นเสียซ้ำ — ตรวจ confluence ให้เข้ม";
    return {
      side: p.side,
      factorKeys: p.factorKeys,
      losses: p.losses,
      wins: p.wins,
      winRate: p.winRate,
      noteTh: `❌ ${p.side === "long" ? "Long" : "Short"} ${factors}: แพ้ ${p.losses}/${p.n} (WR ${fmtWr(p.winRate)}) — ${tip}`,
      tipTh: tip,
      samples: p.samples,
    };
  });

  const winNotes = winningPatterns.map((p) => {
    const factors = p.factorKeys.join("+");
    return {
      side: p.side,
      factorKeys: p.factorKeys,
      wins: p.wins,
      losses: p.losses,
      winRate: p.winRate,
      noteTh: `✅ ${p.side === "long" ? "Long" : "Short"} ${factors}: ชนะ ${p.wins}/${p.n} (WR ${fmtWr(p.winRate)}) — เก็บแพทเทิร์น`,
      samples: p.samples,
    };
  });

  // Few-shot for AI: recent concrete losses + wins with factors
  const fewShot = [];
  const recentLoss = [...losses]
    .filter((g) => g.factorKeys.length >= 2)
    .sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt)))
    .slice(0, 5);
  const recentWin = [...wins]
    .filter((g) => g.factorKeys.length >= 2)
    .sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt)))
    .slice(0, 3);
  for (const g of recentLoss) {
    fewShot.push({
      outcome: "loss",
      side: g.side,
      symbol: g.symbol,
      factors: g.factorKeys,
      aiAction: g.aiAction || "send",
      lessonTh: `เคยพลาด: ${g.side} [${g.factorKeys.join("+")}]${g.aiAction ? ` AI=${g.aiAction}` : ""} — อย่าส่งซ้ำถ้าสัญญาณคล้าย`,
    });
  }
  for (const g of recentWin) {
    fewShot.push({
      outcome: "win",
      side: g.side,
      symbol: g.symbol,
      factors: g.factorKeys,
      aiAction: g.aiAction || "send",
      lessonTh: `เคยถูก: ${g.side} [${g.factorKeys.join("+")}] — confluence แบบนี้โอเค`,
    });
  }

  // Soft bias (conservative)
  let vetoBias = 0;
  if (gradedN >= 8 && winRate != null) {
    if (winRate < 0.35) vetoBias = 0.25;
    else if (winRate < 0.45) vetoBias = 0.15;
    else if (winRate > 0.6) vetoBias = 0;
    else vetoBias = 0.05;
  }
  // If boost losses dominate, nudge vetoBias up slightly
  const boostL = aiStats.boost.l;
  const boostW = aiStats.boost.w;
  if (boostL >= 2 && boostL > boostW) vetoBias = clamp(vetoBias + 0.1, 0, 0.35);

  const cautionFactorKeys = losingPatterns.slice(0, 6).map((p) => p.factorKeys);
  const preferBoostKeys = winningPatterns
    .filter((p) => (p.winRate ?? 0) >= 0.65 && p.wins >= 3)
    .slice(0, 4)
    .map((p) => p.factorKeys);

  const adjustments = [];
  if (vetoBias > 0) {
    adjustments.push({
      key: "vetoBias",
      value: vetoBias,
      noteTh: `ปรับ AI ให้ระวังขึ้น (vetoBias=${vetoBias.toFixed(2)}) เพราะ WR ระยะต้น ${fmtWr(winRate)} จาก ${gradedN} เคส`,
    });
  } else if (gradedN >= 8) {
    adjustments.push({
      key: "vetoBias",
      value: 0,
      noteTh: `คง vetoBias=0 — WR ระยะต้น ${fmtWr(winRate)} ยังไม่ต้องเข้มเพิ่ม`,
    });
  }
  if (cautionFactorKeys.length) {
    adjustments.push({
      key: "cautionPatterns",
      value: cautionFactorKeys.length,
      noteTh: `จำแพทเทิร์นเสีย ${cautionFactorKeys.length} แบบ (เช่น ${cautionFactorKeys[0].join("+")}) — ส่งเข้า AI context`,
    });
  }
  if (preferBoostKeys.length) {
    adjustments.push({
      key: "preferBoost",
      value: preferBoostKeys.length,
      noteTh: `แพทเทิร์นชนะชัด ${preferBoostKeys.length} แบบ — อนุญาต boost เมื่อตรง`,
    });
  }
  adjustments.push({
    key: "guards",
    value: MIN_FACTORS_FLOOR,
    noteTh: `คงกฎแข็ง: ≥${MIN_FACTORS_FLOOR} ปัจจัยซ่อน · SL ≤${MAX_SL_PCT}% · ไม่ลด confluence · NOW ปิด`,
  });

  const bias = {
    updatedAt: new Date().toISOString(),
    vetoBias,
    cautionFactorKeys,
    preferBoostKeys,
    minFactorsFloor: MIN_FACTORS_FLOOR,
    maxSlPct: MAX_SL_PCT,
    earlyWinRate: winRate,
    earlyGraded: gradedN,
    aiActionStats: {
      send: { wins: aiStats.send.w, losses: aiStats.send.l },
      boost: { wins: aiStats.boost.w, losses: aiStats.boost.l },
      veto: { wins: aiStats.veto.w, losses: aiStats.veto.l },
    },
  };

  const insights = {
    updatedAt: new Date().toISOString(),
    rollingAlerts: ROLLING_ALERTS,
    stats: {
      earlyGraded: gradedN,
      earlyWins: wins.length,
      earlyLosses: losses.length,
      earlyWinRate: winRate,
      confluenceAlerts: usable.length,
      casesTotal: cases.length,
    },
    mistakes,
    wins: winNotes,
    aiFewShot: fewShot.slice(0, MAX_FEWSHOT),
    adjustments,
    biasSummary: {
      vetoBias,
      cautionCount: cautionFactorKeys.length,
      preferBoostCount: preferBoostKeys.length,
      minFactorsFloor: MIN_FACTORS_FLOOR,
      maxSlPct: MAX_SL_PCT,
    },
    disclaimerTh:
      "เรียนรู้จากผล Early จริง (heuristic) — ใช้ปรับ AI/โค้ช ไม่การันตีกำไร และไม่ใช่คำแนะนำการลงทุน",
  };

  return { insights, bias };
}

function appendCoachInsightNotes(insights) {
  const coach = readJson(COACH_FILE, { notes: [] });
  const notes = Array.isArray(coach?.notes) ? coach.notes : [];
  const stamp = insights.updatedAt.slice(0, 13); // hourly dedupe key
  const marker = `learn:${stamp}`;
  if (notes.some((n) => n.source === "learn" && String(n.id || "").startsWith(marker))) {
    return 0;
  }
  let added = 0;
  for (const m of (insights.mistakes || []).slice(0, 3)) {
    notes.push({
      id: `${marker}:m:${added}`,
      symbol: "LEARN",
      side: m.side,
      outcome: "loss",
      noteTh: m.noteTh,
      timestamp: insights.updatedAt,
      source: "learn",
      tier: "insight",
      labelTh: "เรียนรู้ความผิดพลาด",
    });
    added++;
  }
  for (const a of (insights.adjustments || []).slice(0, 2)) {
    notes.push({
      id: `${marker}:a:${added}`,
      symbol: "ADJ",
      side: "long",
      outcome: "neutral",
      noteTh: `🔧 ${a.noteTh}`,
      timestamp: insights.updatedAt,
      source: "learn",
      tier: "adjust",
      labelTh: "ปรับโมเดล",
    });
    added++;
  }
  writeJson(COACH_FILE, { notes: notes.slice(-80) });
  return added;
}

function main() {
  ensureDataDir();
  const alerts = loadEarly();
  const cases = loadLearnedCases();
  const { insights, bias } = buildInsights(alerts, cases);
  writeJson(INSIGHTS_FILE, insights);
  writeJson(BIAS_FILE, bias);
  const coachAdded = appendCoachInsightNotes(insights);

  console.log("=== learn-from-mistakes ===");
  console.log(
    `early_graded=${insights.stats.earlyGraded} wr=${insights.stats.earlyWinRate != null ? (insights.stats.earlyWinRate * 100).toFixed(1) + "%" : "n/a"} mistakes=${insights.mistakes.length} wins=${insights.wins.length} fewshot=${insights.aiFewShot.length} vetoBias=${bias.vetoBias} coach_added=${coachAdded}`
  );
  for (const m of insights.mistakes.slice(0, 5)) console.log(`  ${m.noteTh}`);
  for (const a of insights.adjustments) console.log(`  adj: ${a.noteTh}`);
}

main();
