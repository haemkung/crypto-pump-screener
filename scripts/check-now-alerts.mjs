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
    poorWrSkipBelow: 0.35,
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
function passesAlertFilter(side, row, settings, meta) {
  if (settings.mode === "all") return true;

  const wr = side === "long" ? meta.longWr : meta.shortWr;
  const graded = side === "long" ? meta.longGraded : meta.shortGraded;
  if (
    graded >= 5 &&
    wr != null &&
    Number.isFinite(wr) &&
    wr < settings.poorWrSkipBelow
  ) {
    return false;
  }

  const score = Number(side === "long" ? row.score : row.shortScore);
  if (!Number.isFinite(score)) return false;

  const eff = side === "long" ? meta.effLong : meta.effShort;
  const settingsMin =
    side === "long" ? settings.minLongScore : settings.minShortScore;
  const raisedFloor = Math.max(settingsMin, eff + 5);
  const urgencyFloor = side === "long" ? 60 : 55;
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

function appendAlertLog(freshRows, delivered) {
  const log = loadAlertLog();
  const sentAt = new Date().toISOString();
  for (const f of freshRows) {
    const row = f.row;
    const score = f.side === "long" ? row.score : row.shortScore;
    const flags = f.side === "long" ? row.flags : row.shortFlags;
    const entryMode = f.side === "long" ? row.entryMode : row.shortEntryMode;
    log.alerts.push({
      id: randomUUID(),
      symbol: f.symbol,
      side: f.side,
      sentAt,
      price: Number(row.price),
      score: score != null ? Number(score) : null,
      flags: Array.isArray(flags) ? flags : [],
      entryMode: entryMode || null,
      urgency: row.urgency || (f.side === "long" ? "now_long" : "now_short"),
      delivered: !!delivered,
      outcomes: { "15m": null, "60m": null },
      filterMode: f.filterMode || null,
    });
  }
  if (log.alerts.length > 500) log.alerts = log.alerts.slice(-500);
  saveAlertLog(log);
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
  const reason = (row.urgencyReasonTh || "").trim();
  const lines = [
    `⚡ เข้าตอนนี้ (${label}) ${symbol}`,
    `ราคา ${price} | 24h ${pct}` + (score != null ? ` | score ${score}` : ""),
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
  if (skippedSharp > 0) {
    console.log(`sent_new=0 mode=${settings.mode} skipped_filter=${skippedSharp}`);
  }
  quietExit(0);
}

appendAlertLog(fresh, false);

if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) {
  console.error("TELEGRAM_BOT_TOKEN is not set (alert-log still updated)");
  quietExit(1);
}
if (!existsSync(CHAT_ID_FILE)) {
  console.error("Missing .telegram-chat-id — send /start to the bot first (alert-log still updated)");
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
  quietExit(send.status || 1);
}

try {
  const log = loadAlertLog();
  const n = fresh.length;
  for (let i = log.alerts.length - n; i < log.alerts.length; i++) {
    if (i >= 0 && log.alerts[i]) log.alerts[i].delivered = true;
  }
  saveAlertLog(log);
} catch {
  /* non-fatal */
}

for (const f of fresh) state.sent[f.key] = now;
saveState(state);
console.log(
  `sent_new=${fresh.length} mode=${settings.mode} skipped_filter=${skippedSharp}`
);
quietExit(0);
