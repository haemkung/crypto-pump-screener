#!/usr/bin/env node
/**
 * Append Thai post-trade coach notes for recently graded cases,
 * and rebuild false-pattern memory from alert-log losses.
 * Heuristic only — not financial advice.
 *
 * Usage: node scripts/post-trade-coach.mjs
 * Also invoked at end of evaluate-alert-outcomes.mjs
 */
import { randomUUID } from "node:crypto";
import {
  ensureDataDir,
  writeJson,
  readJson,
  loadAlertLog,
  loadLearnedCases,
  DATA_DIR,
  LEARNED_CASES_FILE,
} from "./lib/learning-core.mjs";
import { resolve } from "node:path";

const COACH_FILE = resolve(DATA_DIR, "coach-notes.json");
const FALSE_PATTERNS_FILE = resolve(DATA_DIR, "false-patterns.json");
const MAX_NOTES = 80;

const SEED_PATTERNS = [
  {
    id: "thin_late_long",
    flags: ["thin_liquidity", "late_chase"],
    side: "long",
    hits: 0,
    blockNow: true,
    noteTh: "Thin + Late มักพลาด Long",
  },
  {
    id: "thin_late_short",
    flags: ["thin_liquidity", "late_short_chase"],
    side: "short",
    hits: 0,
    blockNow: true,
    noteTh: "Thin + Late Short มักพลาด",
  },
  {
    id: "no_spot_late",
    flags: ["no_spot", "late_chase"],
    side: "long",
    hits: 0,
    blockNow: true,
    noteTh: "No Spot + Late",
  },
];

function loadCoach() {
  const raw = readJson(COACH_FILE, { notes: [] });
  return { notes: Array.isArray(raw?.notes) ? raw.notes : [] };
}

function saveCoach(file) {
  writeJson(COACH_FILE, { notes: file.notes.slice(-MAX_NOTES) });
}

function buildNoteTh(c, flags) {
  const sideTh = c.side === "long" ? "Long" : "Short";
  const dir = c.movePct >= 0 ? "+" : "";
  const hz = c.horizon ? ` (${c.horizon})` : "";
  const flagHint = flags?.length ? ` · flags: ${flags.slice(0, 3).join(",")}` : "";
  if (c.outcome === "win") {
    return `✅ ${c.symbol} ${sideTh}${hz}: ทำงานได้ — ราคา ${dir}${Number(c.movePct).toFixed(2)}% ตรงทิศ${flagHint}. เก็บแพทเทิร์นที่คล้ายไว้`;
  }
  if (c.outcome === "loss") {
    const tip =
      flags?.includes("thin_liquidity") || flags?.includes("late_chase")
        ? " ระวัง thin/late ในครั้งหน้า"
        : " ทบทวน MTF + regime ก่อนเข้า";
    return `❌ ${c.symbol} ${sideTh}${hz}: พลาด — ราคา ${dir}${Number(c.movePct).toFixed(2)}%${flagHint}.${tip}`;
  }
  return `➖ ${c.symbol} ${sideTh}${hz}: ยังไม่ชัด — ราคา ${dir}${Number(c.movePct).toFixed(2)}% รอข้อมูลเพิ่ม`;
}

function rebuildFalsePatterns(log) {
  let file = readJson(FALSE_PATTERNS_FILE, null);
  if (!file?.patterns) {
    file = { updatedAt: null, patterns: [...SEED_PATTERNS] };
  }
  const pairCounts = new Map();
  for (const a of log.alerts || []) {
    const outs = a.outcomes || {};
    const lost = Object.values(outs).some((o) => o === "loss");
    if (!lost) continue;
    const flags = [...new Set((a.flags || []).filter(Boolean))].sort();
    if (flags.length < 2) continue;
    const side = a.side === "short" ? "short" : "long";
    for (let i = 0; i < flags.length; i++) {
      for (let j = i + 1; j < flags.length; j++) {
        const pair = [flags[i], flags[j]];
        const key = `${side}|${pair.join("+")}`;
        const prev = pairCounts.get(key);
        if (prev) prev.n++;
        else pairCounts.set(key, { flags: pair, side, n: 1 });
      }
    }
  }
  for (const [key, v] of pairCounts) {
    const id = `auto_${key.replace(/\|/g, "_").replace(/\+/g, "_")}`;
    const existing = file.patterns.find((p) => p.id === id);
    if (existing) {
      existing.hits = Math.max(existing.hits || 0, v.n);
    } else if (v.n >= 2) {
      file.patterns.push({
        id,
        flags: v.flags,
        side: v.side,
        hits: v.n,
        blockNow: v.n >= 3,
        noteTh: `แพทเทิร์นเสียซ้ำ: ${v.flags.join("+")}`,
      });
    }
  }
  for (const p of file.patterns) {
    if (!String(p.id).startsWith("auto_")) {
      const key = `${p.side}|${[...p.flags].sort().join("+")}`;
      const found = pairCounts.get(key);
      if (found) p.hits = Math.max(p.hits || 0, found.n);
    }
  }
  file.updatedAt = new Date().toISOString();
  writeJson(FALSE_PATTERNS_FILE, file);
  return file;
}

function main() {
  ensureDataDir();
  const cases = loadLearnedCases();
  const log = loadAlertLog();
  const flagByAlert = new Map();
  for (const a of log.alerts || []) {
    if (a?.id) flagByAlert.set(a.id, Array.isArray(a.flags) ? a.flags : []);
  }

  const coach = loadCoach();
  const seen = new Set(
    coach.notes.map((n) => `${n.alertId || ""}|${n.horizon || ""}|${n.outcome}`)
  );

  // Coach notes for last ~20 graded win/loss (skip pure neutral spam)
  const recent = [...cases]
    .filter((c) => c.outcome === "win" || c.outcome === "loss")
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
    .slice(0, 25);

  let added = 0;
  for (const c of recent) {
    const key = `${c.alertId || ""}|${c.horizon || ""}|${c.outcome}`;
    if (seen.has(key)) continue;
    const flags = flagByAlert.get(c.alertId) || [];
    coach.notes.push({
      id: randomUUID(),
      symbol: c.symbol,
      side: c.side,
      outcome: c.outcome,
      noteTh: buildNoteTh(c, flags),
      timestamp: c.timestamp || new Date().toISOString(),
      alertId: c.alertId,
      horizon: c.horizon,
      movePct: c.movePct,
    });
    seen.add(key);
    added++;
  }
  saveCoach(coach);

  const fp = rebuildFalsePatterns(log);
  console.log("=== post-trade-coach ===");
  console.log(
    `coach_added=${added} coach_total=${coach.notes.length} false_patterns=${fp.patterns.length}`
  );
}

main();
