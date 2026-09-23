#!/usr/bin/env node
/**
 * Poll /api/alerts/now, format Thai short NOW alerts, dedupe 30m by symbol+side,
 * send new ones via Telegram. Exit quietly when nothing new.
 *
 * Also appends each fresh NOW alert to data/alert-log.json for outcome learning.
 *
 * High-confidence "sharp" mode (default): only send if score clears a raised
 * floor, and skip a side temporarily when learned WR is known and very poor.
 *
 * Reads:
 *   TELEGRAM_BOT_TOKEN from env
 *   TELEGRAM_CHAT_ID from ../.telegram-chat-id
 *   data/alert-settings.json (created with sharp defaults if missing)
 * State:
 *   ../.alert-state.json
 *   ../data/alert-log.json (gitignored)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CHAT_ID_FILE = resolve(ROOT, ".telegram-chat-id");
const STATE_FILE = resolve(ROOT, ".alert-state.json");
const DATA_DIR = resolve(ROOT, "data");
const ALERT_LOG_FILE = resolve(DATA_DIR, "alert-log.json");
const ALERT_SETTINGS_FILE = resolve(DATA_DIR, "alert-settings.json");
const LEARNED_WEIGHTS_FILE = resolve(DATA_DIR, "learned-weights.json");
const ALERTS_URL = process.env.ALERTS_NOW_URL || "http://127.0.0.1:3000/api/alerts/now";
const DEDUPE_MS = 30 * 60 * 1000;

const DEFAULT_NOW_LONG = 55;
const DEFAULT_NOW_SHORT = 50;

function quietExit(code = 0) {
  process.exit(code);
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
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

/** Load or create sharp defaults. Env ALERT_MODE=all|sharp overrides mode. */
function loadAlertSettings() {
  const defaults = {
    mode: "sharp",
    minLongScore: DEFAULT_NOW_LONG + 5,
    minShortScore: DEFAULT_NOW_SHORT + 5,
    poorWrSkipBelow: 0.4,
    poorWrMinGraded: 4,
    minGrade: "A",
    pauseShort: true,
    requireGradeAOnly: true,
    updatedAt: null,
  };
  let raw = readJson(ALERT_SETTINGS_FILE, null);
  if (!raw || typeof raw !== "object") {
    raw = { ...defaults, updatedAt: new Date().toISOString() };
    writeJson(ALERT_SETTINGS_FILE, raw);
  }
  const modeEnv = (process.env.ALERT_MODE || "").trim().toLowerCase();
  const mode =
    modeEnv === "all" || modeEnv === "sharp"
      ? modeEnv
      : raw.mode === "all"
        ? "all"
        : "sharp";
  const minGrade =
    raw.minGrade === "A" || raw.minGrade === "B" || raw.minGrade === "C"
      ? raw.minGrade
      : defaults.minGrade;
  return {
    mode,
    minLongScore:
      typeof raw.minLongScore === "number" ? raw.minLongScore : defaults.minLongScore,
    minShortScore:
      typeof raw.minShortScore === "number"
        ? raw.minShortScore
        : defaults.minShortScore,
    poorWrSkipBelow:
      typeof raw.poorWrSkipBelow === "number"
        ? raw.poorWrSkipBelow
        : defaults.poorWrSkipBelow,
    poorWrMinGraded:
      typeof raw.poorWrMinGraded === "number"
        ? raw.poorWrMinGraded
        : defaults.poorWrMinGraded,
    minGrade,
    pauseShort: raw.pauseShort !== false, // default true until Short WR recovers
    requireGradeAOnly: raw.requireGradeAOnly !== false,
  };
}

function loadLearnedSideMeta() {
  const w = readJson(LEARNED_WEIGHTS_FILE, null);
  const longWr = w?.long?.winRate ?? null;
  const shortWr = w?.short?.winRate ?? null;
  const longGraded = w?.long?.graded ?? 0;
  const shortGraded = w?.short?.graded ?? 0;
  const effLong =
    w?.effective?.nowLongMinScore ?? DEFAULT_NOW_LONG;
  const effShort =
    w?.effective?.nowShortMinScore ?? DEFAULT_NOW_SHORT;
  return { longWr, shortWr, longGraded, shortGraded, effLong, effShort };
}

/**
 * Sharp filter: score >= max(settings.min, effectiveNow+5)
 * OR (urgency present AND score >= 60 long / 55 short).
 * Skip side if learned WR known (graded>=5) and WR < poorWrSkipBelow.
 */
function meetsMinGrade(grade, minGrade, score, requireAOnly) {
  const g = grade === "A" || grade === "B" || grade === "C" ? grade : "C";
  if (requireAOnly) return g === "A";
  const min = minGrade === "A" || minGrade === "B" || minGrade === "C" ? minGrade : "A";
  if (min === "C") return true;
  if (min === "B") return g === "A" || g === "B";
  // min A: allow A, and strong B (score >= 65)
  if (g === "A") return true;
  if (g === "B" && score >= 65) return true;
  return false;
}

function sideGrade(side, row) {
  if (side === "short") {
    return row.shortQualityGrade || row.qualityGrade || "C";
  }
  return row.qualityGrade || "C";
}

function entryModeOf(side, row) {
  if (side === "short") {
    return (
      row.shortEntryMode ||
      (row.shortEntry && row.shortEntry.mode) ||
      null
    );
  }
  return row.entryMode || (row.entry && row.entry.mode) || null;
}

/** Enter-now telegram only after opposite-side sweep+reclaim. Fail closed. */
function sweepConfirmed(row) {
  if (!row || row.sweepConfirmed !== true) return false;
  const u = row.urgency;
  if (u === "wait_sweep_long" || u === "wait_sweep_short") return false;
  const lab = String(row.urgencyLabelTh || "");
  if (lab.includes("รอกิน") || lab.includes("รอแท่งกลับ")) return false;
  return true;
}

function passesAlertFilter(side, row, settings, meta) {
  // "all" skips sharp score/grade filters but still must not send before sweep.
  // pauseShort stays inside sharp mode only — do not change that gate.
  if (settings.mode === "all") {
    return sweepConfirmed(row);
  }

  // Hard pause Short Telegram while paper Short WR is weak.
  if (side === "short" && settings.pauseShort) return false;

  if (!sweepConfirmed(row)) return false;

  const wr = side === "long" ? meta.longWr : meta.shortWr;
  const graded = side === "long" ? meta.longGraded : meta.shortGraded;
  const minGraded = settings.poorWrMinGraded ?? 4;
  if (
    graded >= minGraded &&
    wr != null &&
    Number.isFinite(wr) &&
    wr < settings.poorWrSkipBelow
  ) {
    return false;
  }

  const score = Number(side === "long" ? row.score : row.shortScore);
  if (!Number.isFinite(score)) return false;

  // Skip late/chase entries for Telegram — those have been losing recently.
  const mode = entryModeOf(side, row);
  if (mode === "late" || mode === "chase" || mode === "สายแล้ว") return false;

  const grade = sideGrade(side, row);
  if (
    !meetsMinGrade(
      grade,
      settings.minGrade || "A",
      score,
      !!settings.requireGradeAOnly,
    )
  ) {
    return false;
  }

  const eff = side === "long" ? meta.effLong : meta.effShort;
  const settingsMin =
    side === "long" ? settings.minLongScore : settings.minShortScore;
  const raisedFloor = Math.max(settingsMin, eff + 5);
  const urgencyFloor = side === "long" ? 65 : 60;
  const hasUrgency = !!row.urgency;

  if (score >= raisedFloor) return true;
  if (hasUrgency && score >= urgencyFloor) return true;
  return false;
}

function loadState() {
  if (!existsSync(STATE_FILE)) return { sent: {} };
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return { sent: raw.sent && typeof raw.sent === "object" ? raw.sent : {} };
  } catch {
    return { sent: {} };
  }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function loadAlertLog() {
  if (!existsSync(ALERT_LOG_FILE)) return { alerts: [] };
  try {
    const raw = JSON.parse(readFileSync(ALERT_LOG_FILE, "utf8"));
    const alerts = Array.isArray(raw?.alerts)
      ? raw.alerts
      : Array.isArray(raw)
        ? raw
        : [];
    return { alerts };
  } catch {
    return { alerts: [] };
  }
}

function saveAlertLog(log) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(ALERT_LOG_FILE, JSON.stringify(log, null, 2) + "\n", "utf8");
}

/** Append fresh NOW alerts to alert-log. Returns entry ids. Never skip logging. */
function appendAlertLog(freshRows, delivered) {
  const log = loadAlertLog();
  const sentAt = new Date().toISOString();
  const ids = [];
  for (const f of freshRows) {
    const row = f.row;
    const score = f.side === "long" ? row.score : row.shortScore;
    const flags = f.side === "long" ? row.flags : row.shortFlags;
    const entryMode = f.side === "long" ? row.entryMode : row.shortEntryMode;
    const id = randomUUID();
    ids.push(id);
    log.alerts.push({
      id,
      symbol: f.symbol,
      side: f.side,
      sentAt,
      price: Number(row.price),
      score: score != null ? Number(score) : null,
      flags: Array.isArray(flags) ? flags : [],
      entryMode: entryMode || null,
      urgency: row.urgency || (f.side === "long" ? "now_long" : "now_short"),
      delivered: !!delivered,
      outcomes: { "5m": null, "15m": null, "60m": null },
      filterMode: f.filterMode || null,
    });
  }
  if (log.alerts.length > 500) log.alerts = log.alerts.slice(-500);
  saveAlertLog(log);
  return ids;
}

function markAlertLogDelivered(ids, delivered) {
  if (!ids?.length) return;
  const log = loadAlertLog();
  const want = new Set(ids);
  let changed = 0;
  for (const a of log.alerts) {
    if (want.has(a.id)) {
      a.delivered = !!delivered;
      changed++;
    }
  }
  if (changed > 0) saveAlertLog(log);
}

function keyFor(symbol, side) {
  return `${symbol}|${side}`;
}

function fmtPct(n) {
  if (n == null || Number.isNaN(Number(n))) return "?";
  const v = Number(n);
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

function fmtPrice(n) {
  if (n == null || Number.isNaN(Number(n))) return "?";
  const v = Number(n);
  if (v >= 1) return v.toFixed(4);
  if (v >= 0.01) return v.toFixed(5);
  return v.toPrecision(4);
}

function formatRow(row, side) {
  const symbol = row.symbol || row.baseAsset || "?";
  const label = side === "long" ? "Long" : "Short";
  const score = side === "long" ? row.score : row.shortScore;
  const pct = fmtPct(row.priceChangePercent);
  const price = fmtPrice(row.price);
  const grade = row.qualityGrade ? `เกรด ${row.qualityGrade}` : "";
  const mtf = row.mtfAlign ? row.mtfAlign.replace("mtf_", "MTF ") : "";
  const reason = (row.urgencyReasonTh || "").trim();
  const sweptLabel = String(row.urgencyLabelTh || "").trim();
  const head = sweptLabel || `เข้าตอนนี้ (${label})`;
  const lines = [
    `⚡ ${head} · ${symbol}` + (grade ? ` · ${grade}` : ""),
    `ราคา ${price} | 24h ${pct}` + (score != null ? ` | score ${score}` : "") + (mtf ? ` | ${mtf}` : ""),
  ];
  if (reason) lines.push(reason);
  return lines.join("\n");
}

const settings = loadAlertSettings();
const meta = loadLearnedSideMeta();

let res;
try {
  res = await fetch(ALERTS_URL, { signal: AbortSignal.timeout(25_000) });
} catch (e) {
  console.error("alerts fetch failed:", String(e));
  quietExit(1);
}
if (!res.ok) {
  console.error("alerts HTTP", res.status);
  quietExit(1);
}
const data = await res.json();
const longRows = Array.isArray(data.long) ? data.long : [];
const shortRows = Array.isArray(data.short) ? data.short : [];

const now = Date.now();
const state = loadState();
for (const [k, ts] of Object.entries(state.sent)) {
  if (typeof ts !== "number" || now - ts > DEDUPE_MS) delete state.sent[k];
}

const fresh = [];
let skippedSharp = 0;
for (const row of longRows) {
  const symbol = row.symbol;
  if (!symbol) continue;
  if (!passesAlertFilter("long", row, settings, meta)) {
    skippedSharp++;
    continue;
  }
  const k = keyFor(symbol, "long");
  if (state.sent[k] && now - state.sent[k] < DEDUPE_MS) continue;
  fresh.push({
    side: "long",
    symbol,
    text: formatRow(row, "long"),
    key: k,
    row,
    filterMode: settings.mode,
  });
}
for (const row of shortRows) {
  const symbol = row.symbol;
  if (!symbol) continue;
  if (!passesAlertFilter("short", row, settings, meta)) {
    skippedSharp++;
    continue;
  }
  const k = keyFor(symbol, "short");
  if (state.sent[k] && now - state.sent[k] < DEDUPE_MS) continue;
  fresh.push({
    side: "short",
    symbol,
    text: formatRow(row, "short"),
    key: k,
    row,
    filterMode: settings.mode,
  });
}

if (fresh.length === 0) {
  // Quieter heads-up so Telegram is not dead-silent. Not an enter-now.
  const waits = []
    .concat(Array.isArray(data.waitingLong) ? data.waitingLong.map((r) => ({ side: "long", row: r })) : [])
    .concat(Array.isArray(data.waitingShort) ? data.waitingShort.map((r) => ({ side: "short", row: r })) : []);
  const waitFresh = [];
  for (const item of waits) {
    const row = item.row;
    const symbol = row && row.symbol;
    if (!symbol) continue;
    const k = "wait|" + keyFor(symbol, item.side);
    if (state.sent[k] && now - state.sent[k] < DEDUPE_MS) continue;
    const score = item.side === "long" ? row.score : row.shortScore;
    waitFresh.push({
      key: k,
      text:
        `⏳ รอแท่งกลับหลังทะลุ — ยังไม่เข้า (${item.side === "long" ? "Long" : "Short"}) · ${symbol}\n` +
        `ราคา ${fmtPrice(row.price)} | 24h ${fmtPct(row.priceChangePercent)}` +
        (score != null ? ` | score ${score}` : "") +
        `\nยังไม่ใช่เข้าตอนนี้`,
    });
    if (waitFresh.length >= 2) break;
  }
  if (waitFresh.length && process.env.TELEGRAM_BOT_TOKEN?.trim() && existsSync(CHAT_ID_FILE)) {
    const body =
      `แจ้งเตือน crypto-pump-screener · รอแท่งกลับ (${waitFresh.length})\n` +
      `ไม่ใช่คำแนะนำการลงทุน\n—\n\n` +
      waitFresh.map((w) => w.text).join("\n\n");
    const send = spawnSync(
      process.execPath,
      [resolve(__dirname, "send-telegram.mjs"), body],
      { env: process.env, encoding: "utf8" },
    );
    if (send.status === 0) {
      for (const w of waitFresh) state.sent[w.key] = now;
      saveState(state);
      console.log(`sent_wait=${waitFresh.length} mode=${settings.mode} skipped_filter=${skippedSharp}`);
      quietExit(0);
    }
    if (send.stderr) process.stderr.write(send.stderr);
  }
  if (skippedSharp > 0) {
    console.log(`sent_new=0 mode=${settings.mode} skipped_filter=${skippedSharp}`);
  }
  quietExit(0);
}

// Always log BEFORE Telegram send so learning never depends on delivery.
let logIds;
try {
  logIds = appendAlertLog(fresh, false);
} catch (e) {
  console.error("alert-log append failed — aborting send:", String(e));
  quietExit(1);
}

if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) {
  console.error("TELEGRAM_BOT_TOKEN is not set (alert-log still updated, delivered=false)");
  quietExit(1);
}
if (!existsSync(CHAT_ID_FILE)) {
  console.error("Missing .telegram-chat-id — send /start to the bot first (alert-log still updated, delivered=false)");
  quietExit(1);
}

const modeTag = settings.mode === "sharp" ? "สัญญาณคม" : "ทั้งหมด";
const header =
  `แจ้งเตือน crypto-pump-screener · เข้าตอนนี้ (${fresh.length} รายการใหม่ · ${modeTag})\n` +
  `ไม่ใช่คำแนะนำการลงทุน\n` +
  `—`;
const body = [header, ...fresh.map((f) => f.text)].join("\n\n");

const send = spawnSync(
  process.execPath,
  [resolve(__dirname, "send-telegram.mjs"), body],
  { env: process.env, encoding: "utf8" },
);
if (send.status !== 0) {
  if (send.stderr) process.stderr.write(send.stderr);
  if (send.stdout) process.stderr.write(send.stdout);
  // Log entries remain with delivered=false for auto-eval.
  quietExit(send.status || 1);
}

try {
  markAlertLogDelivered(logIds, true);
} catch (e) {
  console.error("alert-log delivered update failed (entries already logged):", String(e));
}

for (const f of fresh) state.sent[f.key] = now;
saveState(state);
console.log(
  `sent_new=${fresh.length} mode=${settings.mode} skipped_filter=${skippedSharp}`
);
quietExit(0);
