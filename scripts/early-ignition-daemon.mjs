#!/usr/bin/env node
/**
 * Early-tier Telegram daemon — CONFLUENCE FIRST, price only as timing.
 *
 * Rule: a price move alone NEVER alerts. Every alert needs >= N independent "hidden" evidence factors
 * measured BEFORE the move (lib/early-ignition-core.mjs → evaluateEvidence):
 *   F1 OI build while price flat · F2 funding against the crowd · F3 crowded opposite side (global L/S)
 *   F4 taker buy/sell imbalance · F5 quiet volume inflow · F6 spot leading · F7 (short) pumped & fading
 *   F8 top traders positioned against the crowd
 * Risk: every alert states a structural SL capped at RISK.maxSlPct (skip if > RISK.skipSlPct), TP1 1.5R / TP2 3R;
 * the same functions grade the backtest (scripts/walkforward-early.mjs) and live alerts (a.trade).
 *
 * Tiers
 *   👀 จ้อง / พร้อมโจมตี (pre-order, web always): 1–2 hidden factors OR priority scout (OI-build) hits —
 *       NOT yet full confluence. Short Telegram optional/capped (👀 จ้อง…). Promote only when ≥3 + AI send/boost.
 *   👀 กำลังสะสม / 👀 กำลังแจกของ (watch, every 5 min): F1 required + total >= WATCH_MIN_FACTORS.
 *   🚀 เริ่มขยับ / 🔻 เริ่มทุบ (ระยะต้น, every ~60s): early price breakout (timing trigger) AND
 *       >= IGN_MIN_FACTORS evidence factors as of the bar BEFORE the move.
 *
 * Rate limits: 1× /fapi/v1/ticker/24hr per minute; 1m klines only for movers (cap 40);
 * evidence endpoints (/futures/data/*, spot klines) only for price-trigger hits (cap 6/cycle) and
 * for OI-build passers of the rotating 5-min watch batch (<=120 openInterestHist calls / 5 min).
 *
 * Telegram switches: data/early-alert-settings.json (sendIgnitionLong/Short, sendWatchLong/Short, caps).
 * Everything (incl. price-only triggers that FAILED confluence) is logged + self-graded in
 * data/early-alerts.json so live precision can be compared with the price-only baseline.
 *
 * Flags: --once, --dry-run (no Telegram, no state/log writes), --ai-dry (run AI review even in dry-run), --probe SYMBOL (print evidence now, exit). Heuristic only — not financial advice.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_THRESHOLDS,
  TRIGGER_THRESHOLDS,
  CONFLUENCE_RULES,
  evaluateIgnition,
  evaluateEvidence,
  gradePath,
  dedupeAllows,
  barsNeeded,
  relMove,
  MAX_PER_CYCLE,
  DEDUPE_MS,
  MIN_REL_MOVE,
  FACTOR_LABELS,
  structuralStop,
  simulateTrade,
  RISK,
} from "./lib/early-ignition-core.mjs";
import { reviewEarlySignal } from "./lib/ai-realtime-review.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
/** Load gitignored .env.secrets into process.env (does not override existing). Never logs values. */
(function loadEnvSecrets() {
  try {
    const p = resolve(ROOT, ".env.secrets");
    if (!existsSync(p)) return;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const eq = s.indexOf("=");
      if (eq < 1) continue;
      const k = s.slice(0, eq).trim();
      let v = s.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (k && process.env[k] == null) process.env[k] = v;
    }
  } catch { /* ignore */ }
})();
(() => {
  const hasOpenAI = !!(process.env.OPENAI_API_KEY || "").trim();
  const hasXai = !!(process.env.XAI_API_KEY || "").trim();
  const provider = hasOpenAI ? "openai" : hasXai ? "xai" : "off";
  // never log key material — name + presence only
  console.log(`[early-ignition] ai-review provider=${provider}`);
})();

const DATA_DIR = resolve(ROOT, "data");
const STATE_FILE = resolve(ROOT, ".early-alert-state.json");
const LOG_FILE = resolve(DATA_DIR, "early-alerts.json");
const STATUS_DIR = resolve(ROOT, "logs/early-ignition");
const STATUS_FILE = resolve(STATUS_DIR, "status.json");
const CHAT_ID_FILE = resolve(ROOT, ".telegram-chat-id");
const SETTINGS_FILE = resolve(DATA_DIR, "early-alert-settings.json");
/** small public snapshot served by /api/early-tiers (web UI) */
const TIERS_FILE = resolve(DATA_DIR, "early-tiers.json");
/** persisted price snaps so restart does not wait ~5 min for warm/shortlist */
const SNAPS_FILE = resolve(DATA_DIR, "early-price-snaps.json");
const SNAPS_DISK_KEEP_MS = 25 * 60e3; // enough for 5/10/15m move + margin
const SNAPS_SEED_LIMIT = 20; // 1m bars per symbol on cold start
const SNAPS_SEED_SYMBOLS = 60; // top liquid + majors
const TIERS_SHOW_MS = { watch: 8 * 3600e3, ignition: 6 * 3600e3, preOrder: 4 * 3600e3 };
/** frozen walk-forward parameters + OOS stats (scripts/walkforward-early.mjs → data/early-tier-config.json) */
const TIER_CONFIG_FILE = resolve(DATA_DIR, "early-tier-config.json");
const DEFAULT_TIER_CFG = {
  ignition_long: { params: { minFactors: 3, minDirectional: 1, requireRelMove: true, slMode: "swing15" } },
  ignition_short: { params: { minFactors: 3, minDirectional: 1, requireRelMove: true, slMode: "swing15" } },
  watch_long: { params: { minFactors: 3, minDirectional: 2, slMode: "swing60" } },
  watch_short: { params: { minFactors: 3, minDirectional: 2, slMode: "swing60" } },
};
function loadTierConfig() {
  const raw = readJson(TIER_CONFIG_FILE, null);
  const out = {};
  for (const k of Object.keys(DEFAULT_TIER_CFG)) {
    const t = raw?.tiers?.[k];
    const params = { ...DEFAULT_TIER_CFG[k].params, ...(t?.params || {}) };
    params.minFactors = Math.max(3, Number(params.minFactors) || 3); // hard user rule: >= 3 hidden factors
    out[k] = { params, oos: t?.test || null, train: t?.train || null, baselines: t?.baselines || null, verdict: t?.verdict || null };
  }
  out._meta = raw ? { generatedAt: raw.generatedAt, data: raw.data } : null;
  return out;
}

const ONCE = process.argv.includes("--once");
const DRY = process.argv.includes("--dry-run") || process.env.EARLY_DRY_RUN === "1";
/** Call AI during --dry-run only when explicitly requested (saves tokens by default). */
const AI_IN_DRY = process.argv.includes("--ai-dry") || process.env.AI_REVIEW_IN_DRY === "1";
const INTERVAL_MS = Number(process.env.EARLY_INTERVAL_MS || 60_000);

/** Telegram switches: all OFF unless a tier beat the price-only baseline in backtest (see DEPLOY.md). */
const DEFAULT_SETTINGS = {
  sendIgnitionLong: false,
  sendIgnitionShort: false,
  sendWatchLong: false,
  sendWatchShort: false,
  /** Pre-order / กำลังจ้อง: short Telegram ON by default but hard-capped (web always shows). */
  sendPreOrder: true,
  maxIgnitionPer24h: 7,
  maxWatchPer24h: 3,
  maxPreOrderPer24h: 4,
  /** paper-trade → promote: a web-only tier is switched to Telegram automatically once its LIVE forward test
   *  (every confluent alert, graded with its exact SL) reaches n>=20, TP1 rate>=55%, avg>=+0.25R; an auto-enabled
   *  tier is switched back off if its last 20 graded alerts average < -0.1R. */
  autoPromote: true,
  /** Realtime AI review on Telegram candidates only (code filters first). Off when no API key. */
  aiReview: true,
  /** If AI returns veto, block Telegram (alert still logged + shown on web). */
  aiVetoBlocks: true,
};
const PROMOTE = { minN: 20, minTp1: 0.55, minAvgR: 0.25, demoteLastN: 20, demoteMinN: 10, demoteAvgR: -0.1 };
const TIER_SWITCH = [["ignition", "long", "sendIgnitionLong", "🚀 เริ่มขยับ (Long)"], ["ignition", "short", "sendIgnitionShort", "🔻 เริ่มทุบ (Short)"], ["watch", "long", "sendWatchLong", "👀 กำลังสะสม (Long)"], ["watch", "short", "sendWatchShort", "👀 กำลังแจกของ (Short)"]];
function autoPromote(logObj, settings) {
  if (!settings.autoPromote || DRY) return;
  const raw = readJson(SETTINGS_FILE, null);
  if (!raw || typeof raw !== "object") return;
  const notes = [];
  for (const [type, side, key, name] of TIER_SWITCH) {
    const rows = logObj.alerts.filter((a) => a.type === type && a.side === side && a.trade && Number.isFinite(a.slPct) && !a.slSkip).sort((x, y) => Date.parse(x.sentAt) - Date.parse(y.sentAt));
    const n = rows.length, avg = (rs) => rs.reduce((x, a) => x + a.trade.r, 0) / Math.max(1, rs.length);
    const tp1 = rows.filter((a) => a.trade.tp1).length / Math.max(1, n);
    if (!raw[key] && n >= PROMOTE.minN && tp1 >= PROMOTE.minTp1 && avg(rows) >= PROMOTE.minAvgR) {
      raw[key] = true; raw[`${key}Auto`] = true;
      notes.push(`✅ เปิดส่ง Telegram อัตโนมัติ: ${name}\nทดสอบจริงล่วงหน้า (paper) ${n} ครั้ง ถึง TP1 ก่อน SL ${(tp1 * 100).toFixed(0)}% · เฉลี่ย ${avg(rows) >= 0 ? "+" : ""}${avg(rows).toFixed(2)}R/ไม้ (SL ≤${RISK.maxSlPct}%)`);
    }
    const last = rows.slice(-PROMOTE.demoteLastN);
    if (raw[key] && raw[`${key}Auto`] && last.length >= PROMOTE.demoteMinN && avg(last) < PROMOTE.demoteAvgR) {
      raw[key] = false; raw[`${key}Auto`] = false;
      notes.push(`⏸ ปิดส่ง Telegram อัตโนมัติ: ${name}\n${last.length} สัญญาณล่าสุดเฉลี่ย ${avg(last).toFixed(2)}R/ไม้ — กลับไปแสดงบนเว็บอย่างเดียว`);
    }
  }
  if (!notes.length) return;
  raw.updatedAt = new Date().toISOString();
  raw.note = `auto-promote/demote from live forward test (${notes.length} change)`;
  try { writeJsonAtomic(SETTINGS_FILE, raw); } catch (e) { log("settings write failed:", String(e)); return; }
  for (const t of notes) { const r = sendTelegram(t); log("auto-promote:", t.split("\n")[0], r.ok ? "sent" : r.err); }
}

const TRIG = { ...TRIGGER_THRESHOLDS };
const RULES = { ...CONFLUENCE_RULES };
const SHORTLIST_PCT = 0.9;
const KLINE_CAP = 40;
const EVIDENCE_CAP = 6;
const EVAL_COOLDOWN_MS = 15 * 60e3;
const MAX_PER_HOUR = 4;
const SNAP_KEEP_MS = 4 * 3600e3 + 10 * 60e3;
const WATCH_BATCH = 120;
const WATCH_FULL_CAP = 10;
const WATCH_DEDUPE_MS = 4 * 3600e3;
const WATCH_MAX_PER_CYCLE = 2;
const WATCH_MENTION_MS = 12 * 3600e3;
/** Always re-check this many freshest liquid+flat names every watch slot (pre-move scout). */
const WATCH_PRIORITY = 40;
/** Skip watch/ignition chase: already pumped a lot on the day (user hard rule). */
const ALREADY_PUMPED_ABS_PCT = 12;
const MIN_24H_VOL = 5_000_000;
const LOG_KEEP = 2000;
/** Pre-order / พร้อมโจมตี (not entered yet). */
const PREORDER_DEDUPE_MS = 3 * 3600e3;
const PREORDER_TTL_MS = 4 * 3600e3;
const PREORDER_MAX_PER_CYCLE = 3;
const PREORDER_STATUS = {
  watching: "จ้องอยู่",
  waiting_ai: "รอ AI",
  approved: "อนุมัติแล้ว",
  vetoed: "วีโต้",
  expired: "หมดอายุ",
};

const HOSTS = ["https://www.binance.com", "https://fstream.binance.com", "https://fapi.binance.com"];
const HEADERS = { Accept: "application/json", "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) crypto-pump-screener-early/2.0" };
let usedWeight = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const local = new Date(d.getTime() + off * 60e3).toISOString().slice(0, 19);
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
  const mm = String(Math.abs(off) % 60).padStart(2, "0");
  return `${local}${off >= 0 ? "+" : "-"}${hh}:${mm}`;
};
const log = (...a) => console.log(`[${ts()}]`, ...a);
const isRate = (e) => /HTTP 4(29|18)/.test(String(e?.message || e));

async function fapi(path, timeoutMs = 10_000) {
  let lastErr;
  for (const h of HOSTS) {
    try {
      const r = await fetch(h + path, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
      const w = Number(r.headers.get("x-mbx-used-weight-1m"));
      if (Number.isFinite(w) && w > 0) usedWeight = w;
      if (!r.ok) {
        lastErr = new Error(`HTTP ${r.status} ${h}${path.split("?")[0]}`);
        if (r.status === 429 || r.status === 418) throw lastErr;
        continue;
      }
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (isRate(e)) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function readJson(p, fb) {
  try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fb; } catch { return fb; }
}
function writeJsonAtomic(p, v) {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(v, null, 1) + "\n", "utf8");
  renameSync(tmp, p);
}
function loadSettings() {
  let raw = readJson(SETTINGS_FILE, null);
  if (!raw || typeof raw !== "object") {
    raw = { ...DEFAULT_SETTINGS, note: "early tiers: Telegram only for tiers that beat the price-only baseline", updatedAt: new Date().toISOString() };
    try { writeJsonAtomic(SETTINGS_FILE, raw); } catch {}
  }
  const out = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (typeof raw[k] === typeof DEFAULT_SETTINGS[k]) out[k] = raw[k];
  return out;
}

// ---------- universe ----------
let perpSet = null, perpAt = 0;
async function refreshPerps() {
  if (perpSet && Date.now() - perpAt < 3600e3) return;
  try {
    const info = await fapi("/fapi/v1/exchangeInfo", 20_000);
    perpSet = new Set(info.symbols.filter((s) => s.contractType === "PERPETUAL" && s.quoteAsset === "USDT" && s.status === "TRADING").map((s) => s.symbol));
    perpAt = Date.now();
  } catch (e) {
    if (!perpSet) log("exchangeInfo failed (suffix filter fallback):", String(e));
  }
}
const isPerp = (s) => (perpSet ? perpSet.has(s) : s.endsWith("USDT") && !s.includes("_"));

// ---------- snapshots ----------
const snaps = new Map();
let snapsSeeded = false;
function pushSnap(sym, t, p) {
  if (!(p > 0) || !Number.isFinite(t)) return;
  let a = snaps.get(sym);
  if (!a) snaps.set(sym, (a = []));
  const last = a[a.length - 1];
  // de-dupe same-minute samples (seed + live ticker)
  if (last && Math.abs(last.t - t) < 20e3 && Math.abs(last.p - p) / p < 1e-6) return;
  if (last && t < last.t) {
    // insert chronologically when seeding historical klines
    let i = a.length - 1;
    while (i >= 0 && a[i].t > t) i--;
    if (i >= 0 && Math.abs(a[i].t - t) < 20e3) return;
    a.splice(i + 1, 0, { t, p });
  } else {
    a.push({ t, p });
  }
  while (a.length && t - a[0].t > SNAP_KEEP_MS) a.shift();
}
function snapMove(sym, now, p) {
  const a = snaps.get(sym);
  if (!a || !a.length) return null;
  let best = null;
  for (const mins of [5, 10, 15]) {
    const target = now - mins * 60e3;
    let ref = null;
    for (const s of a) if (s.t <= target + 30e3) ref = s;
    if (!ref) continue;
    const m = (p / ref.p - 1) * 100;
    if (best == null || Math.abs(m) > Math.abs(best)) best = m;
  }
  return best;
}
function snapRange(sym, now, mins) {
  const a = snaps.get(sym);
  if (!a || !a.length || now - a[0].t < (mins - 5) * 60e3) return null;
  let hi = -Infinity, lo = Infinity;
  for (const s of a) if (now - s.t <= mins * 60e3) { hi = Math.max(hi, s.p); lo = Math.min(lo, s.p); }
  return lo > 0 ? ((hi - lo) / lo) * 100 : null;
}
function snapsAreWarm(now = Date.now()) {
  // warm once any symbol has a ref old enough for the 5m window (+30s slack)
  const need = now - 5 * 60e3 + 30e3;
  for (const a of snaps.values()) {
    if (a.length && a[0].t <= need) return true;
  }
  return false;
}
function loadSnapsFromDisk() {
  const raw = readJson(SNAPS_FILE, null);
  if (!raw || typeof raw !== "object") return 0;
  const savedAt = Number(raw.savedAt) || 0;
  const now = Date.now();
  if (!savedAt || now - savedAt > SNAPS_DISK_KEEP_MS) return 0;
  const obj = raw.snaps && typeof raw.snaps === "object" ? raw.snaps : null;
  if (!obj) return 0;
  let n = 0;
  for (const [sym, arr] of Object.entries(obj)) {
    if (!Array.isArray(arr)) continue;
    for (const pt of arr) {
      const t = Number(pt?.t ?? pt?.[0]);
      const p = Number(pt?.p ?? pt?.[1]);
      if (!(p > 0) || !Number.isFinite(t)) continue;
      if (now - t > SNAP_KEEP_MS) continue;
      pushSnap(sym, t, p);
      n++;
    }
  }
  return n;
}
function saveSnapsToDisk(now = Date.now()) {
  if (DRY) return;
  const out = {};
  let pts = 0;
  for (const [sym, a] of snaps) {
    const keep = [];
    for (const s of a) {
      if (now - s.t <= SNAPS_DISK_KEEP_MS) keep.push({ t: s.t, p: s.p });
    }
    if (keep.length) {
      // downsample to ~1/min to keep file small
      const sparse = [];
      for (const s of keep) {
        const last = sparse[sparse.length - 1];
        if (!last || s.t - last.t >= 50e3) sparse.push(s);
        else sparse[sparse.length - 1] = s;
      }
      out[sym] = sparse;
      pts += sparse.length;
    }
  }
  try {
    writeJsonAtomic(SNAPS_FILE, { savedAt: now, symbols: Object.keys(out).length, points: pts, snaps: out });
  } catch (e) {
    log("snaps save failed:", String(e).slice(0, 120));
  }
}
/** Seed in-memory snaps from recent 1m klines so warm/shortlist work on cycle 1 after restart. */
async function seedSnapsFromKlines(tickMap, now = Date.now()) {
  if (snapsSeeded || snapsAreWarm(now)) {
    snapsSeeded = true;
    return { seeded: 0, reason: "already_warm" };
  }
  snapsSeeded = true;
  const ranked = [...tickMap.entries()]
    .filter(([, t]) => t.vol24 >= MIN_24H_VOL && t.p > 0)
    .sort((a, b) => b[1].vol24 - a[1].vol24)
    .map(([s]) => s);
  const want = new Set(["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"]);
  for (const s of ranked) {
    want.add(s);
    if (want.size >= SNAPS_SEED_SYMBOLS) break;
  }
  const symbols = [...want];
  let seeded = 0;
  let errors = 0;
  for (let i = 0; i < symbols.length; i += 5) {
    const batch = symbols.slice(i, i + 5);
    await Promise.all(batch.map(async (sym) => {
      try {
        const k = await fapi(`/fapi/v1/klines?symbol=${sym}&interval=1m&limit=${SNAPS_SEED_LIMIT}`, 8_000);
        if (!Array.isArray(k) || !k.length) return;
        for (const row of k) {
          const openT = Number(row[0]);
          const close = Number(row[4]);
          if (!(close > 0) || !Number.isFinite(openT)) continue;
          // use bar close time as snap timestamp
          pushSnap(sym, openT + 60e3 - 1, close);
        }
        seeded++;
      } catch (e) {
        errors++;
        if (isRate(e)) throw e;
      }
    }));
    if (i + 5 < symbols.length) await sleep(80);
  }
  return { seeded, errors, symbols: symbols.length, warm: snapsAreWarm(now) };
}

// ---------- evidence data ----------
let fundingCache = { at: 0, map: new Map() };
async function fundingMap() {
  if (Date.now() - fundingCache.at < 240e3) return fundingCache.map;
  const pi = await fapi("/fapi/v1/premiumIndex", 15_000);
  const m = new Map();
  for (const x of pi) m.set(x.symbol, Number(x.lastFundingRate) * 100);
  fundingCache = { at: Date.now(), map: m };
  return m;
}
/** Timestamps normalised like the backtest: futures/data bucket ts + 5m - 1 (= when it is known). */
async function fetchEvidenceData(symbol, tk) {
  const now = Date.now();
  const d = { p5: [], oi5: [], ls5: [], top5: [], tk5: [], spot5: null, fundingPct: null, day: { high24: tk.high24, low24: tk.low24 } };
  const k = await fapi(`/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=300`);
  d.p5 = k.filter((x) => Number(x[6]) < now).map((x) => [Number(x[6]), +x[2], +x[3], +x[4], +x[7]]);
  const oi = await fapi(`/futures/data/openInterestHist?symbol=${symbol}&period=5m&limit=60`);
  d.oi5 = oi.map((x) => [Number(x.timestamp) + 299999, Number(x.sumOpenInterest)]).sort((a, b) => a[0] - b[0]);
  try {
    const ls = await fapi(`/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=60`);
    d.ls5 = ls.map((x) => [Number(x.timestamp) + 299999, Number(x.longShortRatio)]).sort((a, b) => a[0] - b[0]);
  } catch (e) { if (isRate(e)) throw e; }
  try {
    const tp = await fapi(`/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=5m&limit=60`);
    d.top5 = tp.map((x) => [Number(x.timestamp) + 299999, Number(x.longShortRatio)]).sort((a, b) => a[0] - b[0]);
  } catch (e) { if (isRate(e)) throw e; }
  try {
    const t = await fapi(`/futures/data/takerlongshortRatio?symbol=${symbol}&period=5m&limit=40`);
    d.tk5 = t.map((x) => [Number(x.timestamp) + 299999, Number(x.buyVol), Number(x.sellVol)]).sort((a, b) => a[0] - b[0]);
  } catch (e) { if (isRate(e)) throw e; }
  try {
    const spotSym = symbol.replace(/^1000+/, "");
    const r = await fetch(`https://www.binance.com/api/v3/klines?symbol=${spotSym}&interval=5m&limit=310`, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const s = await r.json();
      if (Array.isArray(s) && s.length > 100) d.spot5 = s.filter((x) => Number(x[6]) < now).map((x) => [Number(x[6]), +x[4], +x[7], +x[10]]);
    }
  } catch {}
  try { d.fundingPct = (await fundingMap()).get(symbol) ?? null; } catch {}
  return d;
}
function passes(ev, minFactors, minDirectional, requireKey) {
  if (ev.count < minFactors || ev.directional < minDirectional) return false;
  if (requireKey && !ev.factors.some((f) => f.key === requireKey)) return false;
  return true;
}

// ---------- formatting ----------
function fmtPrice(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "?";
  if (v >= 1) return v.toFixed(4);
  if (v >= 0.01) return v.toFixed(5);
  return v.toPrecision(4);
}
const fmtPct = (n) => (Number.isFinite(n) ? `${n > 0 ? "+" : ""}${n.toFixed(2)}%` : "?");
const fmtIct = (ms) => new Date(ms).toLocaleTimeString("en-GB", { timeZone: "Asia/Bangkok", hour12: false }).slice(0, 5);
function evidenceLines(factors) {
  return factors.map((f, i) => ` ${i + 1}) ${f.labelTh || FACTOR_LABELS[f.key] || f.key}: ${f.detailTh}`);
}
const pctTxt = (a, b) => { const v = (b / a - 1) * 100; return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`; };
/** grade from frozen OOS stats of the tier (A/B/C) */
function gradeOf(oos) {
  if (!oos || !oos.n) return { g: "-", txt: "ยังไม่มีสถิติย้อนหลังพอ" };
  const g = oos.tp1Rate >= 60 && oos.expR >= 0.4 ? "A" : oos.expR >= 0.2 ? "B" : "C";
  return { g, txt: `ทดสอบย้อนหลัง (นอกช่วงจูน ${oos.days ?? "?"} วัน): ถึง TP1 ก่อน SL ${oos.tp1Rate}% จาก ${oos.n} ครั้ง · คาดหวัง ${oos.expR > 0 ? "+" : ""}${oos.expR}R/ไม้ · แพ้ติดกันสูงสุด ${oos.maxConsecLoss}` };
}
function tradeLines(a) {
  const d = a.side === "long" ? 1 : -1;
  const zoneA = a.entry * (1 - (d * 0.2 * a.slPct) / 100), zoneB = a.entry * (1 + (d * 0.15) / 100);
  const [z1, z2] = a.side === "long" ? [zoneA, zoneB] : [zoneB, zoneA];
  return [
    `🎯 โซนเข้า: ${fmtPrice(z1)} – ${fmtPrice(z2)} (ราคาสัญญาณ ${fmtPrice(a.entry)})`,
    `🛑 SL: ${fmtPrice(a.sl)} (ห่าง ${a.slPct.toFixed(2)}% · ${a.slNoteTh})`,
    `✅ TP1: ${fmtPrice(a.tp1)} (${pctTxt(a.entry, a.tp1)} · ${RISK.tp1R}R) · TP2: ${fmtPrice(a.tp2)} (${pctTxt(a.entry, a.tp2)} · ${RISK.tp2R}R)`,
    `⚖️ R:R 1:${RISK.tp1R} / 1:${RISK.tp2R} · ปิดครึ่งที่ TP1 แล้วเลื่อน SL มาทุน`,
  ];
}
/** Compact Telegram signal: emoji + tierThai + BASE + Long|Short (no spaces). */
function baseSym(symbol) {
  const s = String(symbol || "").toUpperCase();
  return s.replace(/USDT$/i, "") || s || "?";
}
function compactSignal(kind, side, symbol) {
  const base = baseSym(symbol);
  const sideWord = side === "long" ? "Long" : "Short";
  if (kind === "preOrder") {
    // Short pre-order ping — not an enter alert
    return `👀 จ้อง…${base}${sideWord}`;
  }
  if (kind === "watch") {
    const tier = side === "long" ? "กำลังสะสม" : "กำลังแจกของ";
    return `👀 ${tier}${base}${sideWord}`;
  }
  // ignition
  if (side === "long") return `🚀 เริ่มขยับ${base}Long`;
  return `🔻 เริ่มทุบ${base}Short`;
}
function briefTradeLine(a) {
  if (a?.entry == null || a?.sl == null) return null;
  return `เข้า ${fmtPrice(a.entry)} · SL ${fmtPrice(a.sl)} · TP1 ${fmtPrice(a.tp1)}`;
}
function formatIgnition(a, cfg) {
  const lines = [compactSignal("ignition", a.side, a.symbol)];
  const brief = briefTradeLine(a);
  if (brief) lines.push(brief);
  return lines.join("\n");
}
function formatWatch(w, cfg) {
  const lines = [compactSignal("watch", w.side === "long" || w.tier === "accumulation" ? "long" : "short", w.symbol)];
  const brief = briefTradeLine(w);
  if (brief) lines.push(brief);
  return lines.join("\n");
}
/** Short pre-order Telegram — interest only, not enter. */
function formatPreOrder(a) {
  const n = a.factorCount ?? (a.factors || []).length;
  const keys = (a.factors || []).map((f) => f.key).slice(0, 3).join(",");
  return `${compactSignal("preOrder", a.side, a.symbol)} · ${n}f${keys ? " " + keys : ""} · ยังไม่เข้า`;
}
function preOrderStatusTh(status) {
  return PREORDER_STATUS[status] || PREORDER_STATUS.watching;
}
/** stop/targets for an alert (same function the backtest graded) */
function planTrade(side, entry, mode, bars, t, level) {
  const st = structuralStop(side, entry, { mode, bars, t, level });
  const noteTh = st.structPct > RISK.maxSlPct ? `โครงสร้างต้องการ ${st.structPct}% → ตัดที่เพดาน ${RISK.maxSlPct}%`
    : st.structPct < RISK.minSlPct ? `ขั้นต่ำ ${RISK.minSlPct}% (โครงสร้าง ${st.structPct}%)`
    : mode === "breakout" ? (side === "long" ? "ใต้กรอบ 4 ชม. ที่เพิ่งทะลุ" : "เหนือกรอบ 4 ชม. ที่เพิ่งหลุด")
    : `${side === "long" ? "ใต้โลว์" : "เหนือไฮ"} ${mode.replace("swing", "")} นาทีล่าสุด`;
  return { entry, sl: st.sl, slPct: st.slPct, structPct: st.structPct, tp1: st.tp1, tp2: st.tp2, slSkip: st.skip, slMode: mode, slNoteTh: noteTh };
}

// ---------- telegram ----------
function sendTelegram(text) {
  if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) return { ok: false, err: "TELEGRAM_BOT_TOKEN not set" };
  if (!existsSync(CHAT_ID_FILE)) return { ok: false, err: "missing .telegram-chat-id" };
  const r = spawnSync(process.execPath, [resolve(__dirname, "send-telegram.mjs"), text], { env: process.env, encoding: "utf8", timeout: 20_000 });
  return r.status === 0 ? { ok: true } : { ok: false, err: (r.stderr || r.stdout || "").trim().slice(0, 200) };
}

// ---------- grading (big move + small move) ----------
const HORIZONS = { "5m": [5, 0.8], "15m": [15, 1.5], "60m": [60, 3.0] };
async function gradeOpen(logObj, priceMap, now) {
  let changed = false;
  let budget = 8; // kline fetches per cycle for path grading
  for (const a of logObj.alerts) {
    if (!a.outcomes) a.outcomes = { "5m": null, "15m": null, "60m": null };
    const age = now - Date.parse(a.sentAt);
    const px = priceMap.get(a.symbol);
    for (const [h, [mins, thr]] of Object.entries(HORIZONS)) {
      if (a.outcomes[h] != null || age < mins * 60e3 || !(px > 0)) continue;
      if (age > (mins + 3) * 60e3) a.outcomes[h] = "missed";
      else {
        const move = (px / a.price - 1) * 100;
        const sm = a.side === "long" ? move : -move;
        a.outcomes[h] = sm >= thr ? "win" : sm <= -thr ? "loss" : "neutral";
        (a.moves ||= {})[h] = Math.round(move * 100) / 100;
      }
      changed = true;
    }
    if (!a.big && age >= (RISK.horizonMin + 2) * 60e3 && budget > 0) {
      budget--;
      try {
        const k = await fapi(`/fapi/v1/klines?symbol=${a.symbol}&interval=1m&startTime=${a.barCloseMs - 60e3}&limit=${RISK.horizonMin + 2}`);
        const bars = k.map((x) => [x[0], +x[1], +x[2], +x[3], +x[4], +x[7]]);
        if (bars.length > 30) {
          if (Number.isFinite(a.slPct)) {
            const e = bars.findIndex((b) => b[0] >= a.barCloseMs);
            if (e >= 0) { const sim = simulateTrade(bars, e, a.side, a.slPct); a.trade = { tp1: sim.tp1, tp2: sim.tp2, r: sim.r, fill: sim.entry, gradedAt: new Date(now).toISOString() }; }
          }
          const big = gradePath(bars, 0, a.side, 8, 2, 720);
          const small = gradePath(bars, 0, a.side, 3, 2, 240);
          a.big = { rule: a.side === "long" ? "+8% before -2% in 12h" : "-8% before +2% in 12h", result: big.result, mfePct: Math.round(big.mfe * 100) / 100 };
          a.small = { rule: a.side === "long" ? "+3% before -2% in 4h" : "-3% before +2% in 4h", result: small.result };
          changed = true;
        }
      } catch {}
    }
  }
  if (changed) {
    const stats = { updatedAt: ts(), total: logObj.alerts.length };
    for (const type of ["ignition", "ignition_price_only", "watch"]) for (const side of ["long", "short"]) {
      const sel = logObj.alerts.filter((a) => a.type === type && a.side === side && a.big);
      const dec = (k) => sel.filter((a) => a[k].result === "win" || a[k].result === "loss");
      const wins = (k) => dec(k).filter((a) => a[k].result === "win").length;
      stats[`${type}_${side}`] = { graded: sel.length, bigWins: wins("big"), bigDecided: dec("big").length, smallWins: wins("small"), smallDecided: dec("small").length };
    }
    logObj.stats = stats;
  }
  return changed;
}

/** live self-graded stats of confluence-era alerts (trade simulated with the exact stated SL) */
function liveStats(logObj) {
  const out = {};
  for (const type of ["ignition", "watch"]) for (const side of ["long", "short"]) {
    const rows = logObj.alerts.filter((a) => a.type === type && a.side === side && a.trade && Number.isFinite(a.slPct));
    const f = (sel) => { const n = sel.length; const w = sel.filter((a) => a.trade.tp1).length; return { n, tp1Rate: n ? Math.round((w / n) * 1000) / 10 : null, avgR: n ? Math.round((sel.reduce((x, a) => x + a.trade.r, 0) / n) * 100) / 100 : null }; };
    out[`${type}_${side}`] = { sent: f(rows.filter((a) => a.delivered)), all: f(rows.filter((a) => !a.slSkip)) };
  }
  return out;
}

// ---------- web snapshot ----------
function mapTierRow(a, first) {
  return {
    id: a.id, type: a.type, tier: a.tier, symbol: a.symbol, side: a.side, price: a.price, pct24h: a.pct24h ?? null,
    factors: (a.factors || []).map((f) => ({ key: f.key, labelTh: FACTOR_LABELS[f.key] || f.key, detailTh: f.detailTh })),
    factorCount: a.factorCount ?? (a.factors || []).length, directional: a.directional ?? null,
    flaggedAt: a.sentAt, firstFlaggedAt: new Date(first.get(`${a.symbol}|${a.side}`) ?? Date.parse(a.sentAt)).toISOString(),
    telegram: a.delivered ? "sent" : a.suppressed === "sl_too_wide" ? "sl_wide" : a.suppressed === "ai_veto" ? "ai_veto" : /disabled/.test(a.suppressed || "") ? "off" : a.suppressed === "cap" ? "capped" : a.suppressed ? "off" : "failed",
    trigger: a.type === "ignition" ? { moveWindow: a.moveWindow, movePct: a.movePct, volMult: a.volMult, breakoutPct: a.breakoutPct } : null,
    plan: Number.isFinite(a.slPct) ? { entry: a.entry, sl: a.sl, slPct: a.slPct, tp1: a.tp1, tp2: a.tp2, slSkip: !!a.slSkip, slNoteTh: a.slNoteTh } : null,
    trade: a.trade || null,
    ai: a.ai || null,
    status: a.status || null,
    statusTh: a.statusTh || null,
    source: a.source || null,
    noteTh: a.noteTh || null,
  };
}
function writeTiersSnapshot(logObj, settings, now, tierCfg) {
  // confluence-era rows (>= rule min) + pre-order (1–2 factors / scout, not entered yet)
  const recent = logObj.alerts.filter((a) => {
    if (!Array.isArray(a.factors)) return false;
    const ageOk = now - Date.parse(a.sentAt) <= 24 * 3600e3;
    if (!ageOk) return false;
    if (a.type === "watch") return a.factors.length >= RULES.watchMinFactors;
    if (a.type === "ignition") return a.factors.length >= RULES.ignitionMinFactors;
    if (a.type === "preOrder") return a.factors.length >= (RULES.preOrderMinFactors ?? 1);
    return false;
  });
  const first = new Map();
  for (const a of recent) {
    const k = `${a.symbol}|${a.side}`;
    const t = Date.parse(a.sentAt);
    if (!first.has(k) || t < first.get(k)) first.set(k, t);
  }
  const latest = (type) => {
    const m = new Map();
    const ttl = TIERS_SHOW_MS[type] || TIERS_SHOW_MS.watch;
    for (const a of recent) {
      if (a.type !== type || now - Date.parse(a.sentAt) > ttl) continue;
      const k = `${a.symbol}|${a.side}`;
      if (!m.has(k) || Date.parse(a.sentAt) > Date.parse(m.get(k).sentAt)) m.set(k, a);
    }
    return [...m.values()]
      .sort((x, y) => Date.parse(y.sentAt) - Date.parse(x.sentAt))
      .slice(0, 30)
      .map((a) => mapTierRow(a, first));
  };
  let watchRows = latest("watch");
  let ignitionRows = latest("ignition");
  let preOrderRows = latest("preOrder");
  // Drop pre-order that already promoted to watch/ignition (same symbol+side still live).
  const promoted = new Set([...watchRows, ...ignitionRows].map((r) => `${r.symbol}|${r.side}`));
  const preMaxShow = RULES.preOrderMaxFactors ?? 2;
  preOrderRows = preOrderRows.filter((r) => {
    if (promoted.has(`${r.symbol}|${r.side}`)) return false;
    // Hard rule: pre-order panel never shows ≥3 (those belong in watch/ignition)
    if ((r.factorCount ?? (r.factors || []).length) > preMaxShow) return false;
    // Hide expired/vetoed after brief display window (keep approved briefly via status)
    if (r.status === "expired" || r.status === "vetoed") {
      const age = now - Date.parse(r.flaggedAt || "");
      return Number.isFinite(age) && age < 30 * 60e3;
    }
    return true;
  });
  // Restart / quiet-scan: do not flash blank UI while previous cards are still within their own TTL.
  if (!watchRows.length && !ignitionRows.length && !preOrderRows.length) {
    const prev = readJson(TIERS_FILE, null);
    const keep = (rows, type) => (Array.isArray(rows) ? rows : []).filter((r) => {
      const t = Date.parse(r?.flaggedAt || r?.firstFlaggedAt || "");
      return Number.isFinite(t) && now - t <= (TIERS_SHOW_MS[type] || TIERS_SHOW_MS.watch);
    });
    if (prev) {
      watchRows = keep(prev.watch, "watch");
      ignitionRows = keep(prev.ignition, "ignition");
      preOrderRows = keep(prev.preOrder, "preOrder");
    }
  }
  writeJsonAtomic(TIERS_FILE, {
    updatedAt: new Date(now).toISOString(),
    daemonAt: new Date(now).toISOString(),
    daemonPid: process.pid,
    rules: RULES,
    risk: RISK,
    telegram: {
      ignitionLong: settings.sendIgnitionLong,
      ignitionShort: settings.sendIgnitionShort,
      watchLong: settings.sendWatchLong,
      watchShort: settings.sendWatchShort,
      preOrder: !!settings.sendPreOrder,
    },
    tiers: Object.fromEntries(["ignition_long", "ignition_short", "watch_long", "watch_short"].map((k) => [k, { params: tierCfg[k].params, oos: tierCfg[k].oos, baselines: tierCfg[k].baselines ? { priceOnly: tierCfg[k].baselines.priceOnlyTest, random: tierCfg[k].baselines.randomTest } : null, verdict: tierCfg[k].verdict }])),
    backtest: tierCfg._meta,
    live: liveStats(logObj),
    preOrder: preOrderRows,
    watch: watchRows,
    ignition: ignitionRows,
    noteTh: (!watchRows.length && !ignitionRows.length && !preOrderRows.length)
      ? "ยังไม่มีสัญญาณที่ผ่าน confluence ≥3 หรือ pre-order ในช่วง TTL"
      : undefined,
  });
}


// ---------- AI realtime review (candidates about to Telegram only) ----------
function buildAiPayload(a) {
  const factors = (a.factors || []).map((f) => ({
    key: f.key,
    labelTh: FACTOR_LABELS[f.key] || f.labelTh || f.key,
    detailTh: f.detailTh,
  }));
  const oi = factors.find((f) => f.key === "oiBuild");
  return {
    symbol: a.symbol,
    side: a.side,
    tier: a.type === "preOrder" ? "preOrder" : a.type === "watch" ? "watch" : "ignition",
    factors,
    price: a.price ?? a.entry ?? null,
    fundingPct: a.fundingPct ?? null,
    oiNoteTh: oi?.detailTh || null,
    entry: a.entry ?? null,
    slPct: a.slPct ?? null,
    tp1: a.tp1 ?? null,
    tp2: a.tp2 ?? null,
    pct24h: a.pct24h ?? null,
    regime: a.regime || null,
    trigger: a.type === "ignition"
      ? { moveWindow: a.moveWindow, movePct: a.movePct, volMult: a.volMult, breakoutPct: a.breakoutPct }
      : null,
  };
}
function decorateTelegramBody(body, ai) {
  if (!ai || ai.skipped) return body;
  const reason = (ai.reasonTh || "").trim();
  let out = body;
  if (ai.action === "boost") out = `⚡AIบูสต์ ${out}`;
  if (reason) out = `${out}\n🤖 ${reason}`;
  return out;
}
async function reviewMessage(m, settings) {
  const a = m.alerts[0];
  if (!a) return { body: m.body, veto: false };
  const wantAi = settings.aiReview !== false;
  const allowInDry = !DRY || AI_IN_DRY;
  if (!wantAi || !allowInDry) {
    const skipped = {
      ok: false,
      action: "send",
      score: 0,
      reasonTh: !wantAi ? "AI ปิด (ตั้งค่า)" : "AI ข้าม (dry-run)",
      latencyMs: 0,
      skipped: true,
    };
    for (const x of m.alerts) x.ai = { action: skipped.action, score: skipped.score, reasonTh: skipped.reasonTh, skipped: true };
    return { body: m.body, veto: false, ai: skipped };
  }
  const ai = await reviewEarlySignal(buildAiPayload(a));
  const slim = {
    action: ai.action,
    score: ai.score,
    reasonTh: ai.reasonTh,
    model: ai.model || null,
    latencyMs: ai.latencyMs,
    ok: ai.ok,
    skipped: !!ai.skipped,
    cached: !!ai.cached,
    learnedAdjust: ai.learnedAdjust || null,
  };
  for (const x of m.alerts) x.ai = slim;
  log(`ai-review ${a.symbol} ${a.side} action=${ai.action} score=${ai.score} ms=${ai.latencyMs}${ai.cached ? " cached" : ""}${ai.skipped ? " skipped" : ""}`);
  const veto = ai.action === "veto" && settings.aiVetoBlocks !== false;
  if (veto) {
    for (const x of m.alerts) x.suppressed = "ai_veto";
    return { body: m.body, veto: true, ai: slim };
  }
  return { body: decorateTelegramBody(m.body, slim), veto: false, ai: slim };
}

// ---------- ignition ----------
async function ignitionScan(tickMap, shortlist, state, now, settings, tierCfg) {
  const picked = shortlist.slice(0, KLINE_CAP);
  let btcBars = null;
  if (picked.length) {
    try { btcBars = (await fapi(`/fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=20`)).map((x) => [x[0], +x[1], +x[2], +x[3], +x[4], +x[7]]); } catch {}
  }
  const need = barsNeeded(TRIG) + 2;
  const priceHits = [];
  for (let i = 0; i < picked.length; i += 8) {
    await Promise.all(picked.slice(i, i + 8).map(async (c) => {
      try {
        let bars = (await fapi(`/fapi/v1/klines?symbol=${c.s}&interval=1m&limit=${need}`)).map((x) => [x[0], +x[1], +x[2], +x[3], +x[4], +x[7]]);
        while (bars.length && bars[bars.length - 1][0] + 60e3 > Date.now()) bars.pop();
        if (bars.length < barsNeeded(TRIG)) return;
        for (const t of [bars.length - 1, bars.length - 2]) {
          const sig = evaluateIgnition(bars, t, { pct24h: c.pct24h, vol24hUsd: c.vol24 }, TRIG);
          if (!sig) continue;
          let btcMove = NaN;
          if (btcBars && c.s !== "BTCUSDT") {
            const bi = btcBars.findIndex((b) => b[0] === bars[t][0]);
            if (bi >= sig.moveWindow) btcMove = (btcBars[bi][4] / btcBars[bi - sig.moveWindow][4] - 1) * 100;
          }
          const rel = relMove(sig, btcMove);
          const relOk = c.s === "BTCUSDT" || rel >= MIN_REL_MOVE[sig.side];
          const p = tierCfg[`ignition_${sig.side}`].params;
          if (p.requireRelMove && !relOk) continue;
          const plan = planTrade(sig.side, sig.close, p.slMode, bars, t, sig.side === "long" ? sig.rangeHigh : sig.rangeLow);
          priceHits.push({ ...sig, ...plan, symbol: c.s, relMovePct: Math.round(rel * 100) / 100, barCloseMs: bars[t][0] + 60e3, asOf: bars[t - sig.moveWindow][0] + 59999 });
          break;
        }
      } catch (e) { if (isRate(e)) throw e; }
    }));
    if (usedWeight > 1500) break;
  }
  // evidence only for price hits not recently evaluated
  state.evalCache ||= {};
  for (const [k, v] of Object.entries(state.evalCache)) if (now - v > EVAL_COOLDOWN_MS) delete state.evalCache[k];
  const toEval = priceHits
    .filter((h) => !state.evalCache[`${h.symbol}|${h.side}`] && dedupeAllows(state.sent, h.symbol, h.side, h.close, now))
    .sort((a, b) => b.volMult - a.volMult)
    .slice(0, EVIDENCE_CAP);
  const out = [];
  for (const h of toEval) {
    state.evalCache[`${h.symbol}|${h.side}`] = now;
    try {
      const data = await fetchEvidenceData(h.symbol, tickMap.get(h.symbol));
      const ev = evaluateEvidence(h.side, data, h.asOf);
      h.factors = ev.factors;
      h.directional = ev.directional;
      const p = tierCfg[`ignition_${h.side}`].params;
      h.confluent = passes(ev, p.minFactors, p.minDirectional, null);
      h.fundingPct = data.fundingPct;
    } catch (e) {
      if (isRate(e)) throw e;
      h.factors = [];
      h.confluent = false;
      h.evidenceError = String(e?.message || e).slice(0, 120);
    }
    const wf = state.watchFlags?.[h.symbol];
    if (wf && wf.side === h.side && now - wf.at <= WATCH_MENTION_MS) h.watchFlag = { tier: wf.tier, agoMin: Math.round((now - wf.at) / 60e3) };
    h.suppressed = !h.confluent ? "no_confluence" : h.slSkip ? "sl_too_wide" : h.side === "long" ? (settings.sendIgnitionLong ? null : "long_disabled") : settings.sendIgnitionShort ? null : "short_disabled";
    out.push(h);
  }
  return { priceHits: priceHits.length, evaluated: out };
}

// ---------- watch ----------
let lastWatchSlot = null;
let lastWatchSummary = null;
const watchChecked = new Map();
async function watchScan(tickMap, state, now, settings, tierCfg) {
  const L = 48;
  const elig = [];
  for (const [s, t] of tickMap) {
    if (!(t.vol24 >= MIN_24H_VOL)) continue;
    // Do NOT chase coins that already ran hard — watch is HIDDEN PRE-MOVE only.
    if (Math.abs(t.pct24h) > ALREADY_PUMPED_ABS_PCT) continue;
    const r = snapRange(s, now, 240);
    if (r != null && r > 6) continue; // F1 needs a flat 4h price
    elig.push(s);
  }
  // Priority scout: liquid flat names not checked recently (catch accumulation early).
  // Round-robin alone left thin names unchecked for hours while SOON/MEW/MOVR loaded.
  const byStale = [...elig].sort((a, b) => (watchChecked.get(a) || 0) - (watchChecked.get(b) || 0));
  const byVolFlat = [...elig]
    .filter((s) => Math.abs(tickMap.get(s).pct24h) <= TRIG.max24hAbsPct)
    .sort((a, b) => tickMap.get(b).vol24 - tickMap.get(a).vol24);
  const batchSet = new Set();
  const batch = [];
  const push = (s) => { if (!batchSet.has(s) && batch.length < WATCH_BATCH) { batchSet.add(s); batch.push(s); } };
  for (const s of byVolFlat.slice(0, WATCH_PRIORITY)) push(s);
  for (const s of byStale) push(s);
  const oiPass = [];
  let checked = 0;
  for (let i = 0; i < batch.length; i += 4) {
    await Promise.all(batch.slice(i, i + 4).map(async (s) => {
      try {
        const raw = await fapi(`/futures/data/openInterestHist?symbol=${s}&period=5m&limit=${L + 2}`);
        watchChecked.set(s, Date.now());
        checked++;
        if (!Array.isArray(raw) || raw.length < L + 1) return;
        const pts = raw.map((x) => [Number(x.timestamp) + 299999, Number(x.sumOpenInterest), Number(x.sumOpenInterestValue)]).sort((a, b) => a[0] - b[0]);
        const oi5 = pts.map((x) => [x[0], x[1]]);
        const p5 = pts.map((x) => { const p = x[1] > 0 ? x[2] / x[1] : NaN; return [x[0], p, p, p, 0]; });
        const ev = evaluateEvidence("long", { p5, oi5 }, pts[pts.length - 1][0]);
        if (ev.factors.some((f) => f.key === "oiBuild")) oiPass.push(s);
      } catch (e) { if (isRate(e)) throw e; }
    }));
    await sleep(120);
  }
  const hits = [];
  const scouts = []; // pre-order: 1–2 factors / priority scout, NOT full confluence
  const preMin = RULES.preOrderMinFactors ?? 1;
  const preMax = RULES.preOrderMaxFactors ?? 2;
  for (const s of oiPass.slice(0, WATCH_FULL_CAP)) {
    try {
      const tk = tickMap.get(s);
      if (Math.abs(tk.pct24h) >= ALREADY_PUMPED_ABS_PCT) continue; // never chase already pumped
      const data = await fetchEvidenceData(s, tk);
      const asOf = Date.now();
      let best = null;
      let bestScout = null;
      for (const side of ["long", "short"]) {
        const ev = evaluateEvidence(side, data, asOf);
        const p = tierCfg[`watch_${side}`].params;
        if (passes(ev, p.minFactors, p.minDirectional, "oiBuild")) {
          if (!best || ev.count > best.ev.count) best = { side, ev };
          continue;
        }
        // Pre-order: oiBuild priority scout OR 1–2 hidden factors — NEVER ≥3 (enter needs ≥3)
        const hasOi = ev.factors.some((f) => f.key === "oiBuild");
        const inBand = ev.count >= preMin && ev.count <= preMax;
        if ((hasOi || inBand) && inBand) {
          if (!bestScout || ev.count > bestScout.ev.count || (ev.count === bestScout.ev.count && hasOi && !bestScout.ev.factors.some((f) => f.key === "oiBuild"))) {
            bestScout = { side, ev, hasOi };
          }
        }
      }
      const b5 = data.p5.map((x) => [x[0], x[3], x[1], x[2], x[3]]);
      if (best) {
        // 5m bars as [ts, o, h, l, c]; swing60 = last 12 closed 5m bars
        const mode = tierCfg[`watch_${best.side}`].params.slMode;
        const n5 = Math.max(1, Math.round((Number(String(mode).replace(/\D/g, "")) || 60) / 5));
        const plan = planTrade(best.side, tk.p, `swing${n5}`, b5, b5.length - 1, null);
        plan.slMode = mode;
        plan.slNoteTh = plan.slNoteTh.replace(/swing?\d+ นาทีล่าสุด|\d+ นาทีล่าสุด/, `${n5 * 5} นาทีล่าสุด`);
        hits.push({ symbol: s, side: best.side, tier: best.side === "long" ? "accumulation" : "distribution", factors: best.ev.factors, directional: best.ev.directional, price: tk.p, pct24h: tk.pct24h, fundingPct: data.fundingPct, ...plan });
      } else if (bestScout) {
        const mode = tierCfg[`watch_${bestScout.side}`].params.slMode;
        const n5 = Math.max(1, Math.round((Number(String(mode).replace(/\D/g, "")) || 60) / 5));
        const plan = planTrade(bestScout.side, tk.p, `swing${n5}`, b5, b5.length - 1, null);
        plan.slMode = mode;
        scouts.push({
          symbol: s,
          side: bestScout.side,
          tier: bestScout.side === "long" ? "accumulation" : "distribution",
          source: bestScout.hasOi ? "priority_scout" : "near_miss",
          factors: bestScout.ev.factors,
          directional: bestScout.ev.directional,
          price: tk.p,
          pct24h: tk.pct24h,
          fundingPct: data.fundingPct,
          ...plan,
        });
      }
    } catch (e) { if (isRate(e)) throw e; }
  }
  const fresh = hits.filter((h) => !(state.watchSent[`${h.symbol}|${h.tier}`] && now - state.watchSent[`${h.symbol}|${h.tier}`] < WATCH_DEDUPE_MS));
  for (const h of fresh) h.suppressed = h.slSkip ? "sl_too_wide" : h.side === "long" ? (settings.sendWatchLong ? null : "long_disabled") : settings.sendWatchShort ? null : "short_disabled";
  fresh.sort((a, b) => b.factors.length - a.factors.length);
  const freshScouts = scouts.filter((h) => !(state.preOrderSent?.[`${h.symbol}|${h.side}`] && now - state.preOrderSent[`${h.symbol}|${h.side}`] < PREORDER_DEDUPE_MS));
  freshScouts.sort((a, b) => b.factors.length - a.factors.length || Math.abs(a.pct24h) - Math.abs(b.pct24h));
  return { eligible: elig.length, checked, oiPass: oiPass.length, hits: fresh, scouts: freshScouts };
}

// ---------- main cycle ----------
async function cycle() {
  const t0 = Date.now();
  const settings = loadSettings();
  const tierCfg = loadTierConfig();
  // Mid-flight heartbeat so a long watch/AI cycle does not look "dead" to supervisors,
  // while a true hang (>EARLY_STALE_SEC) still trips auto-restart.
  try {
    writeJsonAtomic(STATUS_FILE, {
      at: ts(),
      pid: process.pid,
      ok: true,
      phase: "cycle_start",
      consecutiveErrors: 0,
      dryRun: DRY,
    });
  } catch {}
  await refreshPerps();
  const tickers = await fapi("/fapi/v1/ticker/24hr", 15_000);
  const now = Date.now();
  const priceMap = new Map();
  const tickMap = new Map();
  const shortlist = [];
  let warm = false;
  for (const tk of tickers) {
    const s = tk.symbol;
    if (!isPerp(s)) continue;
    const p = Number(tk.lastPrice);
    if (!(p > 0)) continue;
    priceMap.set(s, p);
    const pct24h = Number(tk.priceChangePercent);
    const vol24 = Number(tk.quoteVolume);
    tickMap.set(s, { p, pct24h, vol24, high24: Number(tk.highPrice), low24: Number(tk.lowPrice) });
  }
  // Cold start after restart: seed snaps from 1m klines so warm/shortlist rebuild in cycle 1–2.
  if (!snapsAreWarm(now)) {
    try {
      const seed = await seedSnapsFromKlines(tickMap, now);
      log(`snap-seed seeded=${seed.seeded}/${seed.symbols || 0} warm=${seed.warm} errors=${seed.errors || 0} reason=${seed.reason || "kline"}`);
    } catch (e) {
      log("snap-seed error:", String(e?.message || e).slice(0, 160));
    }
  }
  for (const [s, tk] of tickMap) {
    const { p, pct24h, vol24 } = tk;
    const mv = snapMove(s, now, p);
    pushSnap(s, now, p);
    if (mv != null) warm = true;
    if (mv == null || Math.abs(mv) < SHORTLIST_PCT || !(vol24 >= TRIG.min24hVolUsd)) continue;
    // Never chase an already-pumped coin (user rule). Ignition is timing on early moves only.
    if (Math.abs(pct24h) >= ALREADY_PUMPED_ABS_PCT) continue;
    if (Math.abs(pct24h) > TRIG.max24hAbsPct + 1 && Math.abs(pct24h) > 1) {
      if (mv > 0 && pct24h > TRIG.max24hAbsPct + 1) continue;
      if (mv < 0 && pct24h < -TRIG.max24hAbsPct - 1) continue;
    }
    shortlist.push({ s, mv, pct24h, vol24 });
  }
  shortlist.sort((a, b) => Math.abs(b.mv) - Math.abs(a.mv));
  try { saveSnapsToDisk(now); } catch {}

  const state = readJson(STATE_FILE, {});
  state.sent ||= {};
  for (const [k, v] of Object.entries(state.sent)) if (!v || now - v.at > DEDUPE_MS * 2) delete state.sent[k];
  state.recent = (state.recent || []).filter((x) => now - x < 3600e3);
  state.recent24h = (state.recent24h || []).filter((x) => now - x < 24 * 3600e3);
  state.watchSent ||= {};
  for (const [k, v] of Object.entries(state.watchSent)) if (!v || now - v > WATCH_DEDUPE_MS * 2) delete state.watchSent[k];
  state.watchRecent = (state.watchRecent || []).filter((x) => now - x < 24 * 3600e3);
  state.watchFlags ||= {};
  for (const [k, v] of Object.entries(state.watchFlags)) if (!v || now - v.at > WATCH_MENTION_MS) delete state.watchFlags[k];
  state.preOrderSent ||= {};
  for (const [k, v] of Object.entries(state.preOrderSent)) if (!v || now - v > PREORDER_DEDUPE_MS * 2) delete state.preOrderSent[k];
  state.preOrderRecent = (state.preOrderRecent || []).filter((x) => now - x < 24 * 3600e3);
  state.preOrderFlags ||= {};
  for (const [k, v] of Object.entries(state.preOrderFlags)) {
    if (!v) { delete state.preOrderFlags[k]; continue; }
    const age = now - (v.firstAt || v.at || 0);
    // Keep expired/vetoed/approved briefly for web chips, then drop.
    if (age > PREORDER_TTL_MS + 30 * 60e3) delete state.preOrderFlags[k];
    else if (age > PREORDER_TTL_MS && v.status !== "approved" && v.status !== "vetoed" && v.status !== "expired") {
      v.status = "expired";
      v.statusTh = PREORDER_STATUS.expired;
    }
  }

  const logObj = readJson(LOG_FILE, { alerts: [] });
  logObj.alerts ||= [];
  const messages = [];

  // ----- ignition
  const ign = await ignitionScan(tickMap, shortlist, state, now, settings, tierCfg);
  const confl = ign.evaluated.filter((h) => h.confluent);
  const room = Math.max(0, Math.min(MAX_PER_CYCLE, MAX_PER_HOUR - state.recent.length, settings.maxIgnitionPer24h - state.recent24h.length));
  const sendIgn = confl.filter((h) => !h.suppressed).sort((a, b) => b.factors.length - a.factors.length).slice(0, room);
  const ignAlerts = ign.evaluated.map((h) => ({
    id: randomUUID(),
    type: h.confluent ? "ignition" : "ignition_price_only",
    symbol: h.symbol, side: h.side, sentAt: new Date(now).toISOString(), barCloseMs: h.barCloseMs, price: h.close,
    movePct: h.movePct, moveWindow: h.moveWindow, fromBasePct: h.fromBasePct, pct24h: Math.round(h.pct24h * 100) / 100,
    volMult: h.volMult, vol5mUsd: h.vol5mUsd, baseRangePct: h.baseRangePct, breakoutPct: h.breakoutPct, relMovePct: h.relMovePct,
    factors: (h.factors || []).map((f) => ({ key: f.key, detailTh: f.detailTh })), factorCount: (h.factors || []).length, directional: h.directional ?? 0,
    fundingPct: Number.isFinite(h.fundingPct) ? Math.round(h.fundingPct * 10000) / 10000 : null,
    watchFlag: h.watchFlag || null,
    entry: h.entry, sl: h.sl, slPct: h.slPct, structPct: h.structPct, tp1: h.tp1, tp2: h.tp2, slSkip: !!h.slSkip, slMode: h.slMode, slNoteTh: h.slNoteTh,
    suppressed: sendIgn.includes(h) ? null : h.suppressed || "cap",
    delivered: false, dryRun: DRY, outcomes: { "5m": null, "15m": null, "60m": null },
    _h: h,
  }));
  const ignSendable = ignAlerts.filter((a) => !a.suppressed);
  for (const a of ignSendable) messages.push({ alerts: [a], body: formatIgnition({ ...a, factors: a._h.factors }, tierCfg[`ignition_${a.side}`]) });

  // ----- watch (once per 5-min slot, >= 55s into it so the last futures/data bucket is published)
  let watch = null;
  let watchAlerts = [];
  let scoutHits = [];
  const slot = Math.floor(now / 300e3);
  if (slot !== lastWatchSlot && now % 300e3 >= 55e3) {
    lastWatchSlot = slot;
    try {
      watch = await watchScan(tickMap, state, now, settings, tierCfg);
      const wroom = Math.max(0, Math.min(WATCH_MAX_PER_CYCLE, settings.maxWatchPer24h - state.watchRecent.length));
      const sendW = watch.hits.filter((h) => !h.suppressed).slice(0, wroom);
      watchAlerts = watch.hits.map((h) => ({
        id: randomUUID(), type: "watch", tier: h.tier, symbol: h.symbol, side: h.side, sentAt: new Date(now).toISOString(), barCloseMs: now, ts: now,
        price: h.price, pct24h: Math.round(h.pct24h * 100) / 100,
        factors: h.factors.map((f) => ({ key: f.key, detailTh: f.detailTh })), factorCount: h.factors.length, directional: h.directional,
        fundingPct: Number.isFinite(h.fundingPct) ? Math.round(h.fundingPct * 10000) / 10000 : null,
        entry: h.entry, sl: h.sl, slPct: h.slPct, structPct: h.structPct, tp1: h.tp1, tp2: h.tp2, slSkip: !!h.slSkip, slMode: h.slMode, slNoteTh: h.slNoteTh,
        suppressed: sendW.includes(h) ? null : h.suppressed || "cap",
        delivered: false, dryRun: DRY, outcomes: { "5m": null, "15m": null, "60m": null }, _h: h,
      }));
      const ws = watchAlerts.filter((a) => !a.suppressed);
      for (const a of ws) messages.push({ alerts: [a], body: formatWatch({ ...a, factors: a._h.factors }, tierCfg[`watch_${a.side}`]) });
      scoutHits = Array.isArray(watch.scouts) ? watch.scouts : [];
    } catch (e) {
      log("watch error:", String(e?.message || e).slice(0, 200));
    }
  }

  // ----- pre-order / กำลังจ้อง / พร้อมโจมตี (1–2 factors OR priority scout; NOT full enter)
  // Also fold ignition near-misses (price timing hit but confluence < 3).
  const preMin = RULES.preOrderMinFactors ?? 1;
  const preMax = RULES.preOrderMaxFactors ?? 2;
  const ignNear = ign.evaluated
    .filter((h) => !h.confluent && Array.isArray(h.factors) && h.factors.length >= preMin && h.factors.length <= preMax)
    .filter((h) => Math.abs(h.pct24h ?? 0) < ALREADY_PUMPED_ABS_PCT)
    .map((h) => ({
      symbol: h.symbol, side: h.side, tier: h.side === "long" ? "accumulation" : "distribution",
      source: "ignition_near", factors: h.factors, directional: h.directional ?? 0,
      price: h.close, pct24h: h.pct24h, fundingPct: h.fundingPct,
      entry: h.entry, sl: h.sl, slPct: h.slPct, structPct: h.structPct, tp1: h.tp1, tp2: h.tp2,
      slSkip: !!h.slSkip, slMode: h.slMode, slNoteTh: h.slNoteTh,
    }));
  const scoutPool = [...scoutHits, ...ignNear];
  // Dedupe by symbol|side preferring higher factorCount
  const scoutMap = new Map();
  for (const h of scoutPool) {
    const k = `${h.symbol}|${h.side}`;
    const prev = scoutMap.get(k);
    if (!prev || (h.factors?.length || 0) > (prev.factors?.length || 0)) scoutMap.set(k, h);
  }
  const promotedKeys = new Set(
    [...watchAlerts, ...ignAlerts.filter((a) => a.type === "ignition")].map((a) => `${a.symbol}|${a.side}`)
  );
  // Mark existing pre-order flags as approved when they promote this cycle
  for (const k of promotedKeys) {
    const fl = state.preOrderFlags[k];
    if (fl && fl.status !== "approved") {
      fl.status = "approved";
      fl.statusTh = PREORDER_STATUS.approved;
      fl.promotedAt = now;
    }
  }
  // Expire stale flags
  for (const [k, fl] of Object.entries(state.preOrderFlags)) {
    if (fl.status === "approved" || fl.status === "vetoed") continue;
    if (now - (fl.firstAt || fl.at || 0) > PREORDER_TTL_MS) {
      fl.status = "expired";
      fl.statusTh = PREORDER_STATUS.expired;
    }
  }
  const preCandidates = [...scoutMap.values()]
    .filter((h) => !promotedKeys.has(`${h.symbol}|${h.side}`))
    .filter((h) => !(state.preOrderSent[`${h.symbol}|${h.side}`] && now - state.preOrderSent[`${h.symbol}|${h.side}`] < PREORDER_DEDUPE_MS))
    .sort((a, b) => (b.factors?.length || 0) - (a.factors?.length || 0))
    .slice(0, PREORDER_MAX_PER_CYCLE);

  const proom = Math.max(0, Math.min(PREORDER_MAX_PER_CYCLE, (settings.maxPreOrderPer24h ?? 4) - state.preOrderRecent.length));
  let preOrderAlerts = preCandidates.map((h, idx) => {
    const k = `${h.symbol}|${h.side}`;
    const prev = state.preOrderFlags[k];
    const firstAt = prev?.firstAt || now;
    const n = h.factors?.length || 0;
    // Status: 2 factors → waiting AI path; 1 factor / scout → watching
    let status = n >= 2 ? "waiting_ai" : "watching";
    if (prev?.status === "vetoed") status = "vetoed";
    if (prev?.status === "approved") status = "approved";
    if (prev?.status === "expired") status = "expired";
    const wantTg = !!settings.sendPreOrder && status !== "vetoed" && status !== "expired" && idx < proom;
    return {
      id: randomUUID(),
      type: "preOrder",
      tier: h.tier,
      symbol: h.symbol,
      side: h.side,
      sentAt: new Date(now).toISOString(),
      barCloseMs: now,
      ts: now,
      price: h.price,
      pct24h: Math.round((h.pct24h ?? 0) * 100) / 100,
      factors: (h.factors || []).map((f) => ({ key: f.key, detailTh: f.detailTh })),
      factorCount: n,
      directional: h.directional ?? 0,
      fundingPct: Number.isFinite(h.fundingPct) ? Math.round(h.fundingPct * 10000) / 10000 : null,
      entry: h.entry, sl: h.sl, slPct: h.slPct, structPct: h.structPct, tp1: h.tp1, tp2: h.tp2,
      slSkip: !!h.slSkip, slMode: h.slMode, slNoteTh: h.slNoteTh,
      source: h.source || "scout",
      status,
      statusTh: preOrderStatusTh(status),
      noteTh: "pre-order · ยังไม่เข้า · รอ confluence ≥3 + อนุมัติ AI/ระบบ",
      suppressed: wantTg ? null : (settings.sendPreOrder ? "cap" : "preorder_tg_off"),
      delivered: false,
      dryRun: DRY,
      outcomes: { "5m": null, "15m": null, "60m": null },
      firstAt,
      _h: h,
    };
  });
  // Persist flag bookkeeping (even when TG off — web always)
  for (const a of preOrderAlerts) {
    const k = `${a.symbol}|${a.side}`;
    state.preOrderFlags[k] = {
      side: a.side,
      status: a.status,
      statusTh: a.statusTh,
      firstAt: a.firstAt,
      at: now,
      factorCount: a.factorCount,
      source: a.source,
    };
  }
  const preSendable = preOrderAlerts.filter((a) => !a.suppressed);
  for (const a of preSendable) messages.push({ alerts: [a], body: formatPreOrder(a) });

  const allAlerts = [...ignAlerts, ...watchAlerts, ...preOrderAlerts];
  // AI review ONLY for messages about to Telegram (code filters already passed).
  const reviewedMessages = [];
  for (const m of messages) {
    const rev = await reviewMessage(m, settings);
    if (rev.veto) continue;
    reviewedMessages.push({ ...m, body: rev.body });
  }

  if (DRY) {
    for (const m of reviewedMessages) log("DRY-RUN would send:\n" + m.body);
    for (const a of allAlerts.filter((x) => x.suppressed)) log(`DRY-RUN not sent (${a.suppressed}): ${a.type} ${a.symbol} ${a.side} factors=${a.factorCount} [${a.factors.map((f) => f.key).join(",")}]`);
  } else {
    for (const a of allAlerts) { const { _h, ...rest } = a; logObj.alerts.push(rest); }
    for (const m of reviewedMessages) {
      const r = sendTelegram(m.body);
      for (const a of m.alerts) {
        const rec = logObj.alerts.find((x) => x.id === a.id);
        if (rec) {
          rec.delivered = r.ok;
          if (a.ai) rec.ai = a.ai;
        }
      }
      if (!r.ok) log("telegram send failed:", r.err);
    }
    // Persist AI fields + ai_veto suppressions onto log rows (even when not delivered).
    for (const a of allAlerts) {
      const rec = logObj.alerts.find((x) => x.id === a.id);
      if (!rec) continue;
      if (a.ai) rec.ai = a.ai;
      if (a.suppressed) rec.suppressed = a.suppressed;
    }
    for (const a of ignAlerts) {
      if (a.type !== "ignition") continue;
      state.sent[`${a.symbol}|${a.side}`] = { at: now, price: a.price };
      if (!a.suppressed) { state.recent.push(now); state.recent24h.push(now); }
      const pk = `${a.symbol}|${a.side}`;
      if (state.preOrderFlags[pk]) {
        state.preOrderFlags[pk].status = "approved";
        state.preOrderFlags[pk].statusTh = PREORDER_STATUS.approved;
        state.preOrderFlags[pk].promotedAt = now;
      }
    }
    for (const a of watchAlerts) {
      state.watchSent[`${a.symbol}|${a.tier}`] = now;
      state.watchFlags[a.symbol] = { tier: a.tier, side: a.side, at: now };
      if (!a.suppressed) state.watchRecent.push(now);
      // Promotion: full watch enter clears pre-order interest for this symbol|side
      const pk = `${a.symbol}|${a.side}`;
      if (state.preOrderFlags[pk]) {
        state.preOrderFlags[pk].status = "approved";
        state.preOrderFlags[pk].statusTh = PREORDER_STATUS.approved;
        state.preOrderFlags[pk].promotedAt = now;
      }
    }
    for (const a of preOrderAlerts) {
      state.preOrderSent[`${a.symbol}|${a.side}`] = now;
      if (!a.suppressed) state.preOrderRecent.push(now);
      // Reflect AI veto onto status for web chips
      if (a.suppressed === "ai_veto") {
        a.status = "vetoed";
        a.statusTh = PREORDER_STATUS.vetoed;
        const fl = state.preOrderFlags[`${a.symbol}|${a.side}`];
        if (fl) { fl.status = "vetoed"; fl.statusTh = PREORDER_STATUS.vetoed; }
      } else if (a.ai && !a.ai.skipped && (a.ai.action === "send" || a.ai.action === "boost") && a.status === "waiting_ai") {
        // AI OK but still waiting system confluence ≥3 — "พร้อมโจมตี"
        a.status = "approved";
        a.statusTh = PREORDER_STATUS.approved;
        a.noteTh = "AI อนุมัติแล้ว · รอระบบ confluence ≥3 ก่อนเข้าจริง";
        const fl = state.preOrderFlags[`${a.symbol}|${a.side}`];
        if (fl) { fl.status = "approved"; fl.statusTh = PREORDER_STATUS.approved; }
      }
      const rec = logObj.alerts.find((x) => x.id === a.id);
      if (rec) {
        rec.status = a.status;
        rec.statusTh = a.statusTh;
        rec.noteTh = a.noteTh;
        if (a.suppressed) rec.suppressed = a.suppressed;
      }
    }
    await gradeOpen(logObj, priceMap, now);
    try { autoPromote(logObj, settings); } catch (e) { log("autoPromote error:", String(e).slice(0, 120)); }
    // Sync live pre-order flag statuses onto latest matching log rows (expiry / promote).
    for (const [k, fl] of Object.entries(state.preOrderFlags || {})) {
      if (!fl?.status) continue;
      const [sym, side] = k.split("|");
      for (let i = logObj.alerts.length - 1; i >= 0; i--) {
        const a = logObj.alerts[i];
        if (a.type !== "preOrder" || a.symbol !== sym || a.side !== side) continue;
        a.status = fl.status;
        a.statusTh = fl.statusTh || PREORDER_STATUS[fl.status] || a.statusTh;
        if (fl.status === "approved" && fl.promotedAt) {
          a.noteTh = "เลื่อนไปเฝ้าดู/เริ่มขยับแล้ว · เคยเป็น pre-order";
        }
        break;
      }
    }
    if (logObj.alerts.length > LOG_KEEP) logObj.alerts = logObj.alerts.slice(-LOG_KEEP);
    writeJsonAtomic(LOG_FILE, logObj);
    writeJsonAtomic(STATE_FILE, state);
    try { writeTiersSnapshot(logObj, settings, now, tierCfg); } catch (e) { log("snapshot error:", String(e).slice(0, 120)); }
  }

  const lbl = (a) => `${a.symbol}:${a.side}:${a.factorCount}f${a.suppressed ? "(" + a.suppressed + ")" : ""}`;
  if (watch) lastWatchSummary = { at: ts(), eligible: watch.eligible, checked: watch.checked, oiPass: watch.oiPass, hits: watch.hits.length, scouts: (watch.scouts || []).length };
  log(
    `cycle ms=${Date.now() - t0} tickers=${priceMap.size} warm=${warm} shortlist=${shortlist.length} priceHits=${ign.priceHits} evaluated=${ign.evaluated.length} confluent=${confl.length} ${DRY ? "dry" : "sent"}=${ignSendable.length}` +
      (ignAlerts.length ? ` [${ignAlerts.map(lbl).join(",")}]` : "") +
      (watch ? ` | watch checked=${watch.checked}/${watch.eligible} oiBuild=${watch.oiPass} setups=${watch.hits.length}${watchAlerts.length ? " [" + watchAlerts.map(lbl).join(",") + "]" : ""}` : "") +
      (preOrderAlerts.length ? ` | preOrder=${preOrderAlerts.length} [${preOrderAlerts.map(lbl).join(",")}]` : "") +
      ` weight1m=${usedWeight}`,
  );
  try {
    writeJsonAtomic(STATUS_FILE, { at: ts(), pid: process.pid, ok: true, consecutiveErrors: 0, dryRun: DRY, warm, shortlist: shortlist.length, priceHits: ign.priceHits, evaluated: ign.evaluated.length, confluent: confl.length, sent: DRY ? 0 : ignSendable.length, watch: lastWatchSummary, settings, trigger: TRIG, rules: RULES, weight1m: usedWeight });
  } catch {}
}

async function probe(symbol) {
  const t = (await fapi("/fapi/v1/ticker/24hr?symbol=" + symbol));
  const tk = { p: +t.lastPrice, pct24h: +t.priceChangePercent, vol24: +t.quoteVolume, high24: +t.highPrice, low24: +t.lowPrice };
  const data = await fetchEvidenceData(symbol, tk);
  for (const side of ["long", "short"]) {
    const ev = evaluateEvidence(side, data, Date.now());
    console.log(`${symbol} ${side}: factors=${ev.count} directional=${ev.directional} spot=${data.spot5 ? "yes" : "no"} funding=${data.fundingPct}`);
    for (const l of evidenceLines(ev.factors)) console.log(l);
  }
}

async function main() {
  const pi = process.argv.indexOf("--probe");
  if (pi > 0) { await probe(process.argv[pi + 1]); return; }
  log(`early daemon (confluence-first) start pid=${process.pid} dryRun=${DRY} once=${ONCE}`);
  try {
    const n = loadSnapsFromDisk();
    if (n) log(`loaded ${n} price snaps from disk (warm=${snapsAreWarm()})`);
  } catch (e) {
    log("snap load failed:", String(e).slice(0, 120));
  }
  process.on("SIGTERM", () => { log("SIGTERM — exiting"); process.exit(0); });
  process.on("SIGINT", () => process.exit(0));
  process.on("uncaughtException", (e) => log("uncaughtException (kept running):", String(e?.stack || e).slice(0, 300)));
  process.on("unhandledRejection", (e) => log("unhandledRejection (kept running):", String(e?.stack || e).slice(0, 300)));
  let consecutiveErrors = 0;
  let backoff = 0;
  for (;;) {
    try {
      await cycle();
      backoff = 0;
      consecutiveErrors = 0;
    } catch (e) {
      const msg = String(e?.message || e);
      consecutiveErrors++;
      log("cycle error:", msg.slice(0, 200));
      try { writeJsonAtomic(STATUS_FILE, { at: ts(), pid: process.pid, ok: false, consecutiveErrors, lastError: msg.slice(0, 200) }); } catch {}
      if (isRate(e)) backoff = Math.min(600_000, (backoff || 60_000) * 2);
    }
    if (ONCE) break;
    let wait = (64_000 - (Date.now() % 60_000)) % 60_000;
    if (wait < 5_000) wait += 60_000;
    if (INTERVAL_MS !== 60_000) wait = INTERVAL_MS;
    await sleep(wait + backoff);
  }
}
main();
