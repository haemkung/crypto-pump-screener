/**
 * Server-only learning store: alert-log, learned-cases, weight refresh, manual feedback.
 * Mirrors scripts/lib/learning-core.mjs — keep knobs in sync.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { LearnedCase, LearnedOutcome } from "./types";
import { clearLearnedWeightsCache } from "./learnedWeights";

const DATA_DIR = resolve(process.cwd(), "data");
const ALERT_LOG_FILE = resolve(DATA_DIR, "alert-log.json");
const LEARNED_CASES_FILE = resolve(DATA_DIR, "learned-cases.json");
const LEARNED_WEIGHTS_FILE = resolve(DATA_DIR, "learned-weights.json");

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

/** Synthetic move used when user grades manually without a measured price. */
const MANUAL_SYNTH_MOVE = 1.5;

export interface AlertLogEntry {
  id: string;
  symbol: string;
  side: "long" | "short";
  sentAt: string;
  price: number;
  score: number | null;
  flags?: string[];
  entryMode?: string | null;
  urgency?: string;
  delivered?: boolean;
  outcomes: { "5m": LearnedOutcome | null; "15m": LearnedOutcome | null; "60m": LearnedOutcome | null };
  paperPnl?: { "5m"?: number; "15m"?: number; "60m"?: number; manual?: number };
  manualGrade?: {
    outcome: LearnedOutcome;
    note?: string;
    gradedAt: string;
  };
  source?: string;
}

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown) {
  ensureDataDir();
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

export function paperPnlFromMove(side: "long" | "short", movePct: number): number {
  const m = Number(movePct);
  if (!Number.isFinite(m)) return 0;
  return side === "short" ? -m : m;
}

function computeSideKnobs(
  winRate: number | null,
  graded: number,
  prev?: { nowMinScoreDelta?: number; nowPctBandDelta?: number }
) {
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
      scoreDelta =
        scoreDelta > 0 ? scoreDelta - 1 : scoreDelta < 0 ? scoreDelta + 1 : 0;
      bandDelta =
        bandDelta > 0 ? bandDelta - 1 : bandDelta < 0 ? bandDelta + 1 : 0;
    }
  }

  return {
    winRate,
    graded,
    nowMinScoreDelta: clamp(scoreDelta, -2, 2),
    nowPctBandDelta: clamp(bandDelta, -2, 2),
  };
}

export function buildWeights(
  cases: LearnedCase[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prevWeights: any
) {
  const graded = cases
    .filter((c) => c.outcome === "win" || c.outcome === "loss")
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

  function sideRate(side: "long" | "short") {
    const slice = graded.filter((c) => c.side === side).slice(0, ROLLING_N);
    const wins = slice.filter((c) => c.outcome === "win").length;
    const losses = slice.filter((c) => c.outcome === "loss").length;
    const n = wins + losses;
    return { winRate: n > 0 ? wins / n : null, graded: n };
  }

  const longS = sideRate("long");
  const shortS = sideRate("short");
  const long = computeSideKnobs(longS.winRate, longS.graded, prevWeights?.long);
  const short = computeSideKnobs(
    shortS.winRate,
    shortS.graded,
    prevWeights?.short
  );

  return {
    updatedAt: new Date().toISOString(),
    rollingN: ROLLING_N,
    long,
    short,
    effective: {
      nowLongMinScore: clamp(
        DEFAULTS.nowLongMinScore + long.nowMinScoreDelta,
        DEFAULTS.nowLongMinScore - 2,
        DEFAULTS.nowLongMinScore + 2
      ),
      nowShortMinScore: clamp(
        DEFAULTS.nowShortMinScore + short.nowMinScoreDelta,
        DEFAULTS.nowShortMinScore - 2,
        DEFAULTS.nowShortMinScore + 2
      ),
      nowLongPctMin: DEFAULTS.nowLongPctMin,
      nowLongPctMax: clamp(
        DEFAULTS.nowLongPctMax + long.nowPctBandDelta,
        DEFAULTS.nowLongPctMax - 2,
        DEFAULTS.nowLongPctMax + 2
      ),
      nowShortPctMin: clamp(
        DEFAULTS.nowShortPctMin - short.nowPctBandDelta,
        DEFAULTS.nowShortPctMin - 2,
        DEFAULTS.nowShortPctMin + 2
      ),
      nowShortPctMax: DEFAULTS.nowShortPctMax,
    },
  };
}

export function refreshLearnedWeights() {
  const cases = readJson<LearnedCase[]>(LEARNED_CASES_FILE, []);
  const list = Array.isArray(cases) ? cases : [];
  const prev = readJson(LEARNED_WEIGHTS_FILE, null);
  const weights = buildWeights(list, prev);
  writeJson(LEARNED_WEIGHTS_FILE, weights);
  clearLearnedWeightsCache();
  return weights;
}

export function loadAlertLog(): { alerts: AlertLogEntry[] } {
  const raw = readJson<{ alerts?: AlertLogEntry[] } | AlertLogEntry[]>(
    ALERT_LOG_FILE,
    { alerts: [] }
  );
  const alerts = Array.isArray((raw as { alerts?: AlertLogEntry[] })?.alerts)
    ? (raw as { alerts: AlertLogEntry[] }).alerts
    : Array.isArray(raw)
      ? (raw as AlertLogEntry[])
      : [];
  return { alerts };
}

function saveAlertLog(log: { alerts: AlertLogEntry[] }) {
  if (log.alerts.length > 500) log.alerts = log.alerts.slice(-500);
  writeJson(ALERT_LOG_FILE, log);
}

export function loadLearnedCasesList(): LearnedCase[] {
  const raw = readJson<LearnedCase[]>(LEARNED_CASES_FILE, []);
  return Array.isArray(raw) ? raw : [];
}

function saveLearnedCases(cases: LearnedCase[]) {
  const trimmed = cases.length > 400 ? cases.slice(-400) : cases;
  writeJson(LEARNED_CASES_FILE, trimmed);
  return trimmed;
}

export interface PaperPnlSummary {
  longSum: number;
  shortSum: number;
  totalSum: number;
  longAvg: number | null;
  shortAvg: number | null;
  totalAvg: number | null;
  longN: number;
  shortN: number;
  totalN: number;
}

/** Prefer paperPnlPct on case; else derive from movePct + side. */
export function computePaperPnlSummary(
  cases: LearnedCase[],
  rollingN = ROLLING_N
): PaperPnlSummary {
  const graded = cases
    .filter((c) => c.outcome === "win" || c.outcome === "loss")
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

  function sideSlice(side: "long" | "short" | "all") {
    const slice =
      side === "all"
        ? graded.slice(0, rollingN * 2)
        : graded.filter((c) => c.side === side).slice(0, rollingN);
    const pnls = slice.map((c) => {
      if (typeof c.paperPnlPct === "number" && Number.isFinite(c.paperPnlPct)) {
        return c.paperPnlPct;
      }
      return paperPnlFromMove(c.side, c.movePct ?? 0);
    });
    const sum = pnls.reduce((a, b) => a + b, 0);
    const n = pnls.length;
    return { sum, avg: n > 0 ? sum / n : null, n };
  }

  const long = sideSlice("long");
  const short = sideSlice("short");
  const total = sideSlice("all");

  return {
    longSum: Math.round(long.sum * 100) / 100,
    shortSum: Math.round(short.sum * 100) / 100,
    totalSum: Math.round(total.sum * 100) / 100,
    longAvg: long.avg != null ? Math.round(long.avg * 100) / 100 : null,
    shortAvg: short.avg != null ? Math.round(short.avg * 100) / 100 : null,
    totalAvg: total.avg != null ? Math.round(total.avg * 100) / 100 : null,
    longN: long.n,
    shortN: short.n,
    totalN: total.n,
  };
}

export interface ManualFeedbackInput {
  symbol: string;
  side: "long" | "short";
  outcome: "win" | "loss";
  note?: string;
  /** Optional measured move % (raw price change). If omitted, uses synthetic. */
  movePct?: number;
  score?: number | null;
  price?: number | null;
}

export interface ManualFeedbackResult {
  alertId: string;
  caseId: string;
  paperPnlPct: number;
  movePct: number;
  weightsRefreshed: boolean;
}

/**
 * Record manual ถูก/ผิด feedback: synthetic graded alert-log entry + learned case,
 * then refresh learned-weights.
 */
export function applyManualFeedback(
  input: ManualFeedbackInput
): ManualFeedbackResult {
  const symbol = String(input.symbol || "").trim().toUpperCase();
  const side = input.side;
  const outcome = input.outcome;
  if (!symbol || (side !== "long" && side !== "short")) {
    throw new Error("symbol and side (long|short) required");
  }
  if (outcome !== "win" && outcome !== "loss") {
    throw new Error("outcome must be win|loss");
  }

  // Signed raw price move: win → favorable direction, loss → adverse
  let movePct: number;
  if (typeof input.movePct === "number" && Number.isFinite(input.movePct)) {
    movePct = input.movePct;
  } else {
    // Synthetic: long win = +1.5, long loss = -1.5; short win = -1.5, short loss = +1.5
    const mag = MANUAL_SYNTH_MOVE;
    if (side === "long") {
      movePct = outcome === "win" ? mag : -mag;
    } else {
      movePct = outcome === "win" ? -mag : mag;
    }
  }
  movePct = Math.round(movePct * 100) / 100;
  const paperPnlPct =
    Math.round(paperPnlFromMove(side, movePct) * 100) / 100;

  const nowIso = new Date().toISOString();
  const alertId = randomUUID();
  const caseId = randomUUID();
  const priceAtSend =
    typeof input.price === "number" && Number.isFinite(input.price)
      ? input.price
      : 0;
  const priceAtGrade =
    priceAtSend > 0 ? priceAtSend * (1 + movePct / 100) : 0;

  const noteBase =
    outcome === "win"
      ? `${side === "long" ? "Long" : "Short"} ถูก (manual)`
      : `${side === "long" ? "Long" : "Short"} ผิด (manual)`;
  const noteTh = input.note?.trim()
    ? `${noteBase}: ${input.note.trim()}`
    : `${noteBase} — ผู้ใช้ให้คะแนนมือ · paper ${paperPnlPct >= 0 ? "+" : ""}${paperPnlPct.toFixed(2)}%`;

  const log = loadAlertLog();
  const entry: AlertLogEntry = {
    id: alertId,
    symbol,
    side,
    sentAt: nowIso,
    price: priceAtSend,
    score: input.score ?? null,
    flags: [],
    entryMode: null,
    urgency: side === "long" ? "now_long" : "now_short",
    delivered: false,
    outcomes: { "5m": outcome, "15m": outcome, "60m": outcome },
    paperPnl: { manual: paperPnlPct, "5m": paperPnlPct, "15m": paperPnlPct, "60m": paperPnlPct },
    manualGrade: {
      outcome,
      note: input.note?.trim() || undefined,
      gradedAt: nowIso,
    },
    source: "manual",
  };
  log.alerts.push(entry);
  saveAlertLog(log);

  const cases = loadLearnedCasesList();
  const learned: LearnedCase = {
    id: caseId,
    alertId,
    symbol,
    side,
    outcome,
    movePct,
    paperPnlPct,
    horizon: "15m",
    noteTh,
    timestamp: nowIso,
    priceAtSend,
    priceAtGrade,
    score: input.score ?? null,
    source: "manual",
  };
  cases.push(learned);
  saveLearnedCases(cases);

  refreshLearnedWeights();

  return {
    alertId,
    caseId,
    paperPnlPct,
    movePct,
    weightsRefreshed: true,
  };
}
