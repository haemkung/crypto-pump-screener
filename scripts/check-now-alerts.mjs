#!/usr/bin/env node
/**
 * Poll /api/alerts/now, format Thai short NOW alerts, dedupe 30m by symbol+side,
 * send new ones via Telegram. Exit quietly when nothing new.
 *
 * Reads:
 *   TELEGRAM_BOT_TOKEN from env
 *   TELEGRAM_CHAT_ID from ../.telegram-chat-id
 * State:
 *   ../.alert-state.json
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CHAT_ID_FILE = resolve(ROOT, ".telegram-chat-id");
const STATE_FILE = resolve(ROOT, ".alert-state.json");
const ALERTS_URL = process.env.ALERTS_NOW_URL || "http://127.0.0.1:3000/api/alerts/now";
const DEDUPE_MS = 30 * 60 * 1000;

function quietExit(code = 0) {
  process.exit(code);
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
// prune old entries
for (const [k, ts] of Object.entries(state.sent)) {
  if (typeof ts !== "number" || now - ts > DEDUPE_MS) delete state.sent[k];
}

const fresh = [];
for (const row of longRows) {
  const symbol = row.symbol;
  if (!symbol) continue;
  const k = keyFor(symbol, "long");
  if (state.sent[k] && now - state.sent[k] < DEDUPE_MS) continue;
  fresh.push({ side: "long", symbol, text: formatRow(row, "long"), key: k });
}
for (const row of shortRows) {
  const symbol = row.symbol;
  if (!symbol) continue;
  const k = keyFor(symbol, "short");
  if (state.sent[k] && now - state.sent[k] < DEDUPE_MS) continue;
  fresh.push({ side: "short", symbol, text: formatRow(row, "short"), key: k });
}

if (fresh.length === 0) quietExit(0);

if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) {
  console.error("TELEGRAM_BOT_TOKEN is not set");
  quietExit(1);
}
if (!existsSync(CHAT_ID_FILE)) {
  console.error("Missing .telegram-chat-id — send /start to the bot first");
  quietExit(1);
}

const header =
  `แจ้งเตือน crypto-pump-screener · เข้าตอนนี้ (${fresh.length} รายการใหม่)\n` +
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

for (const f of fresh) state.sent[f.key] = now;
saveState(state);
// success: stay relatively quiet but confirm count for operators
console.log(`sent_new=${fresh.length}`);
quietExit(0);
