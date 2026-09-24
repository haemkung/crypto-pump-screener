#!/usr/bin/env node
/**
 * Early-tier Telegram daemon — CONFLUENCE FIRST, price only as timing.
 *
 * Rule: a price move alone NEVER alerts. Every alert needs >= N independent "hidden" evidence factors
 * measured BEFORE the move (lib/early-ignition-core.mjs → evaluateEvidence):
 *   F1 OI build while price flat · F2 funding against the crowd · F3 crowded opposite side (global L/S)
 *   F4 taker buy/sell imbalance · F5 quiet volume inflow · F6 spot leading · F7 (short) pumped & fading
 *
 * Tiers
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
 * Flags: --once, --dry-run (no Telegram, no state/log writes), --probe SYMBOL (print evidence now, exit). Heuristic only — not financial advice.
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
} from "./lib/early-ignition-core.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DATA_DIR = resolve(ROOT, "data");
const STATE_FILE = resolve(ROOT, ".early-alert-state.json");
const LOG_FILE = resolve(DATA_DIR, "early-alerts.json");
const STATUS_DIR = resolve(ROOT, "logs/early-ignition");
const STATUS_FILE = resolve(STATUS_DIR, "status.json");
const CHAT_ID_FILE = resolve(ROOT, ".telegram-chat-id");
const SETTINGS_FILE = resolve(DATA_DIR, "early-alert-settings.json");
/** small public snapshot served by /api/early-tiers (web UI) */
const TIERS_FILE = resolve(DATA_DIR, "early-tiers.json");
const TIERS_SHOW_MS = { watch: 8 * 3600e3, ignition: 6 * 3600e3 };

const ONCE = process.argv.includes("--once");
const DRY = process.argv.includes("--dry-run") || process.env.EARLY_DRY_RUN === "1";
const INTERVAL_MS = Number(process.env.EARLY_INTERVAL_MS || 60_000);

/** Telegram switches: all OFF unless a tier beat the price-only baseline in backtest (see DEPLOY.md). */
const DEFAULT_SETTINGS = {
  sendIgnitionLong: false,
  sendIgnitionShort: false,
  sendWatchLong: false,
  sendWatchShort: false,
  maxIgnitionPer24h: 10,
  maxWatchPer24h: 10,
};

const TRIG = { ...TRIGGER_THRESHOLDS };
const RULES = { ...CONFLUENCE_RULES };
const SHORTLIST_PCT = 0.9;
const KLINE_CAP = 40;
const EVIDENCE_CAP = 6;
const EVAL_COOLDOWN_MS = 15 * 60e3;
const MAX_PER_HOUR = 6;
const SNAP_KEEP_MS = 4 * 3600e3 + 10 * 60e3;
const WATCH_BATCH = 120;
const WATCH_FULL_CAP = 10;
const WATCH_DEDUPE_MS = 4 * 3600e3;
const WATCH_MAX_PER_CYCLE = 2;
const WATCH_MENTION_MS = 12 * 3600e3;
const MIN_24H_VOL = 5_000_000;
const LOG_KEEP = 2000;

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
function pushSnap(sym, t, p) {
  let a = snaps.get(sym);
  if (!a) snaps.set(sym, (a = []));
  a.push({ t, p });
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
  const d = { p5: [], oi5: [], ls5: [], tk5: [], spot5: null, fundingPct: null, day: { high24: tk.high24, low24: tk.low24 } };
  const k = await fapi(`/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=300`);
  d.p5 = k.filter((x) => Number(x[6]) < now).map((x) => [Number(x[6]), +x[2], +x[3], +x[4], +x[7]]);
  const oi = await fapi(`/futures/data/openInterestHist?symbol=${symbol}&period=5m&limit=60`);
  d.oi5 = oi.map((x) => [Number(x.timestamp) + 299999, Number(x.sumOpenInterest)]).sort((a, b) => a[0] - b[0]);
  try {
    const ls = await fapi(`/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=60`);
    d.ls5 = ls.map((x) => [Number(x.timestamp) + 299999, Number(x.longShortRatio)]).sort((a, b) => a[0] - b[0]);
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
  return factors.map((f, i) => ` ${i + 1}) ${f.labelTh}: ${f.detailTh}`);
}
function formatIgnition(a) {
  const head = a.side === "long" ? "🚀 เริ่มขยับ (ระยะต้น)" : "🔻 เริ่มทุบ (ระยะต้น)";
  const lines = [
    `${head} · ${a.symbol}`,
    `หลักฐานก่อนราคาขยับ ${a.factors.length} ข้อ (ขั้นต่ำ ${RULES.ignitionMinFactors}):`,
    ...evidenceLines(a.factors),
    `จังหวะ (trigger ราคา): ${a.moveWindow}m ${fmtPct(a.movePct)} · วอลุ่ม 5m ×${a.volMult} · ${a.side === "long" ? "ทะลุกรอบ 4h" : "หลุดกรอบ 4h"} ${fmtPct(a.breakoutPct)} · ฐาน 2h ${a.baseRangePct}%`,
    `ราคา ${fmtPrice(a.price)} · 24h ${fmtPct(a.pct24h)} · เวลา ${fmtIct(a.barCloseMs)} ICT`,
  ];
  if (a.watchFlag) lines.push(`👀 เคยติด "${a.watchFlag.tier === "accumulation" ? "กำลังสะสม" : "กำลังแจกของ"}" เมื่อ ${(a.watchFlag.agoMin / 60).toFixed(1)} ชม.ก่อน`);
  return lines.join("\n");
}
function formatWatch(w) {
  const head = w.tier === "accumulation" ? "👀 กำลังสะสม (เฝ้าดู)" : "👀 กำลังแจกของ (เฝ้าดู Short)";
  return [
    `${head} · ${w.symbol}`,
    `หลักฐาน ${w.factors.length} ข้อ (ขั้นต่ำ ${RULES.watchMinFactors}):`,
    ...evidenceLines(w.factors),
    `ราคา ${fmtPrice(w.price)} · 24h ${fmtPct(w.pct24h)} · เวลา ${fmtIct(w.ts)} ICT`,
    `ยังไม่ใช่จุดเข้า — รอ trigger ราคา`,
  ].join("\n");
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
    if (!a.big && age >= 12 * 3600e3 + 120e3 && budget > 0) {
      budget--;
      try {
        const k = await fapi(`/fapi/v1/klines?symbol=${a.symbol}&interval=1m&startTime=${a.barCloseMs - 60e3}&limit=722`);
        const bars = k.map((x) => [x[0], +x[1], +x[2], +x[3], +x[4], +x[7]]);
        if (bars.length > 30) {
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
}

// ---------- web snapshot ----------
function writeTiersSnapshot(logObj, settings, now) {
  // only confluence-era rows (factors listed and >= rule minimum); legacy price-only rows never shown
  const recent = logObj.alerts.filter((a) => (a.type === "watch" || a.type === "ignition") && Array.isArray(a.factors) &&
    a.factors.length >= (a.type === "watch" ? RULES.watchMinFactors : RULES.ignitionMinFactors) && now - Date.parse(a.sentAt) <= 24 * 3600e3);
  const first = new Map();
  for (const a of recent) {
    const k = `${a.symbol}|${a.side}`;
    const t = Date.parse(a.sentAt);
    if (!first.has(k) || t < first.get(k)) first.set(k, t);
  }
  const latest = (type) => {
    const m = new Map();
    for (const a of recent) {
      if (a.type !== type || now - Date.parse(a.sentAt) > TIERS_SHOW_MS[type]) continue;
      const k = `${a.symbol}|${a.side}`;
      if (!m.has(k) || Date.parse(a.sentAt) > Date.parse(m.get(k).sentAt)) m.set(k, a);
    }
    return [...m.values()]
      .sort((x, y) => Date.parse(y.sentAt) - Date.parse(x.sentAt))
      .slice(0, 30)
      .map((a) => ({
        id: a.id, type: a.type, tier: a.tier, symbol: a.symbol, side: a.side, price: a.price, pct24h: a.pct24h ?? null,
        factors: (a.factors || []).map((f) => ({ key: f.key, labelTh: FACTOR_LABELS[f.key] || f.key, detailTh: f.detailTh })),
        factorCount: a.factorCount ?? (a.factors || []).length, directional: a.directional ?? null,
        flaggedAt: a.sentAt, firstFlaggedAt: new Date(first.get(`${a.symbol}|${a.side}`) ?? Date.parse(a.sentAt)).toISOString(),
        telegram: a.delivered ? "sent" : /disabled/.test(a.suppressed || "") ? "off" : a.suppressed === "cap" ? "capped" : a.suppressed ? "off" : "failed",
        trigger: a.type === "ignition" ? { moveWindow: a.moveWindow, movePct: a.movePct, volMult: a.volMult, breakoutPct: a.breakoutPct } : null,
      }));
  };
  writeJsonAtomic(TIERS_FILE, {
    updatedAt: new Date(now).toISOString(),
    rules: RULES,
    telegram: { ignitionLong: settings.sendIgnitionLong, ignitionShort: settings.sendIgnitionShort, watchLong: settings.sendWatchLong, watchShort: settings.sendWatchShort },
    watch: latest("watch"),
    ignition: latest("ignition"),
  });
}

// ---------- ignition ----------
async function ignitionScan(tickMap, shortlist, state, now, settings) {
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
          if (c.s !== "BTCUSDT" && rel < MIN_REL_MOVE[sig.side]) continue;
          priceHits.push({ ...sig, symbol: c.s, relMovePct: Math.round(rel * 100) / 100, barCloseMs: bars[t][0] + 60e3, asOf: bars[t - sig.moveWindow][0] + 59999 });
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
      h.confluent = passes(ev, RULES.ignitionMinFactors, RULES.ignitionMinDirectional, null);
      h.fundingPct = data.fundingPct;
    } catch (e) {
      if (isRate(e)) throw e;
      h.factors = [];
      h.confluent = false;
      h.evidenceError = String(e?.message || e).slice(0, 120);
    }
    const wf = state.watchFlags?.[h.symbol];
    if (wf && wf.side === h.side && now - wf.at <= WATCH_MENTION_MS) h.watchFlag = { tier: wf.tier, agoMin: Math.round((now - wf.at) / 60e3) };
    h.suppressed = !h.confluent ? "no_confluence" : h.side === "long" ? (settings.sendIgnitionLong ? null : "long_disabled") : settings.sendIgnitionShort ? null : "short_disabled";
    out.push(h);
  }
  return { priceHits: priceHits.length, evaluated: out };
}

// ---------- watch ----------
let lastWatchSlot = null;
let lastWatchSummary = null;
const watchChecked = new Map();
async function watchScan(tickMap, state, now, settings) {
  const L = 48;
  const elig = [];
  for (const [s, t] of tickMap) {
    if (!(t.vol24 >= MIN_24H_VOL)) continue;
    const r = snapRange(s, now, 240);
    if (r != null && r > 6) continue; // F1 needs a flat 4h price
    elig.push(s);
  }
  elig.sort((a, b) => (watchChecked.get(a) || 0) - (watchChecked.get(b) || 0));
  const batch = elig.slice(0, WATCH_BATCH);
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
  for (const s of oiPass.slice(0, WATCH_FULL_CAP)) {
    try {
      const tk = tickMap.get(s);
      const data = await fetchEvidenceData(s, tk);
      const asOf = Date.now();
      let best = null;
      for (const side of ["long", "short"]) {
        const ev = evaluateEvidence(side, data, asOf);
        if (!passes(ev, RULES.watchMinFactors, RULES.watchMinDirectional, "oiBuild")) continue;
        if (!best || ev.count > best.ev.count) best = { side, ev };
      }
      if (best) hits.push({ symbol: s, side: best.side, tier: best.side === "long" ? "accumulation" : "distribution", factors: best.ev.factors, directional: best.ev.directional, price: tk.p, pct24h: tk.pct24h, fundingPct: data.fundingPct });
    } catch (e) { if (isRate(e)) throw e; }
  }
  const fresh = hits.filter((h) => !(state.watchSent[`${h.symbol}|${h.tier}`] && now - state.watchSent[`${h.symbol}|${h.tier}`] < WATCH_DEDUPE_MS));
  for (const h of fresh) h.suppressed = h.side === "long" ? (settings.sendWatchLong ? null : "long_disabled") : settings.sendWatchShort ? null : "short_disabled";
  fresh.sort((a, b) => b.factors.length - a.factors.length);
  return { eligible: elig.length, checked, oiPass: oiPass.length, hits: fresh };
}

// ---------- main cycle ----------
async function cycle() {
  const t0 = Date.now();
  const settings = loadSettings();
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
    const mv = snapMove(s, now, p);
    pushSnap(s, now, p);
    if (mv != null) warm = true;
    if (mv == null || Math.abs(mv) < SHORTLIST_PCT || !(vol24 >= TRIG.min24hVolUsd)) continue;
    if (Math.abs(pct24h) > TRIG.max24hAbsPct + 1 && Math.abs(pct24h) > 1) {
      if (mv > 0 && pct24h > TRIG.max24hAbsPct + 1) continue;
      if (mv < 0 && pct24h < -TRIG.max24hAbsPct - 1) continue;
    }
    shortlist.push({ s, mv, pct24h, vol24 });
  }
  shortlist.sort((a, b) => Math.abs(b.mv) - Math.abs(a.mv));

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

  const logObj = readJson(LOG_FILE, { alerts: [] });
  logObj.alerts ||= [];
  const messages = [];

  // ----- ignition
  const ign = await ignitionScan(tickMap, shortlist, state, now, settings);
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
    suppressed: sendIgn.includes(h) ? null : h.suppressed || "cap",
    delivered: false, dryRun: DRY, outcomes: { "5m": null, "15m": null, "60m": null },
    _h: h,
  }));
  const ignSendable = ignAlerts.filter((a) => !a.suppressed);
  if (ignSendable.length) {
    messages.push({
      alerts: ignSendable,
      body: `แจ้งเตือน crypto-pump-screener · ระยะต้น (${ignSendable.length})\nสัญญาณระยะต้น เสี่ยงหลอกสูงกว่า ไม่ใช่คำแนะนำการลงทุน\n—\n\n` +
        ignSendable.map((a) => formatIgnition({ ...a, factors: a._h.factors })).join("\n\n"),
    });
  }

  // ----- watch (once per 5-min slot, >= 55s into it so the last futures/data bucket is published)
  let watch = null;
  let watchAlerts = [];
  const slot = Math.floor(now / 300e3);
  if (slot !== lastWatchSlot && now % 300e3 >= 55e3) {
    lastWatchSlot = slot;
    try {
      watch = await watchScan(tickMap, state, now, settings);
      const wroom = Math.max(0, Math.min(WATCH_MAX_PER_CYCLE, settings.maxWatchPer24h - state.watchRecent.length));
      const sendW = watch.hits.filter((h) => !h.suppressed).slice(0, wroom);
      watchAlerts = watch.hits.map((h) => ({
        id: randomUUID(), type: "watch", tier: h.tier, symbol: h.symbol, side: h.side, sentAt: new Date(now).toISOString(), barCloseMs: now, ts: now,
        price: h.price, pct24h: Math.round(h.pct24h * 100) / 100,
        factors: h.factors.map((f) => ({ key: f.key, detailTh: f.detailTh })), factorCount: h.factors.length, directional: h.directional,
        fundingPct: Number.isFinite(h.fundingPct) ? Math.round(h.fundingPct * 10000) / 10000 : null,
        suppressed: sendW.includes(h) ? null : h.suppressed || "cap",
        delivered: false, dryRun: DRY, outcomes: { "5m": null, "15m": null, "60m": null }, _h: h,
      }));
      const ws = watchAlerts.filter((a) => !a.suppressed);
      if (ws.length) {
        messages.push({
          alerts: ws,
          body: `แจ้งเตือน crypto-pump-screener · เฝ้าดู (${ws.length})\nรายการเฝ้าดู ยังไม่ใช่จุดเข้า · ไม่ใช่คำแนะนำการลงทุน\n—\n\n` +
            ws.map((a) => formatWatch({ ...a, factors: a._h.factors })).join("\n\n"),
        });
      }
    } catch (e) {
      log("watch error:", String(e?.message || e).slice(0, 200));
    }
  }

  const allAlerts = [...ignAlerts, ...watchAlerts];
  if (DRY) {
    for (const m of messages) log("DRY-RUN would send:\n" + m.body);
    for (const a of allAlerts.filter((x) => x.suppressed)) log(`DRY-RUN not sent (${a.suppressed}): ${a.type} ${a.symbol} ${a.side} factors=${a.factorCount} [${a.factors.map((f) => f.key).join(",")}]`);
  } else {
    for (const a of allAlerts) { const { _h, ...rest } = a; logObj.alerts.push(rest); }
    for (const m of messages) {
      const r = sendTelegram(m.body);
      for (const a of m.alerts) {
        const rec = logObj.alerts.find((x) => x.id === a.id);
        if (rec) rec.delivered = r.ok;
      }
      if (!r.ok) log("telegram send failed:", r.err);
    }
    for (const a of ignAlerts) {
      if (a.type !== "ignition") continue;
      state.sent[`${a.symbol}|${a.side}`] = { at: now, price: a.price };
      if (!a.suppressed) { state.recent.push(now); state.recent24h.push(now); }
    }
    for (const a of watchAlerts) {
      state.watchSent[`${a.symbol}|${a.tier}`] = now;
      state.watchFlags[a.symbol] = { tier: a.tier, side: a.side, at: now };
      if (!a.suppressed) state.watchRecent.push(now);
    }
    await gradeOpen(logObj, priceMap, now);
    if (logObj.alerts.length > LOG_KEEP) logObj.alerts = logObj.alerts.slice(-LOG_KEEP);
    writeJsonAtomic(LOG_FILE, logObj);
    writeJsonAtomic(STATE_FILE, state);
    try { writeTiersSnapshot(logObj, settings, now); } catch (e) { log("snapshot error:", String(e).slice(0, 120)); }
  }

  const lbl = (a) => `${a.symbol}:${a.side}:${a.factorCount}f${a.suppressed ? "(" + a.suppressed + ")" : ""}`;
  if (watch) lastWatchSummary = { at: ts(), eligible: watch.eligible, checked: watch.checked, oiPass: watch.oiPass, hits: watch.hits.length };
  log(
    `cycle ms=${Date.now() - t0} tickers=${priceMap.size} warm=${warm} shortlist=${shortlist.length} priceHits=${ign.priceHits} evaluated=${ign.evaluated.length} confluent=${confl.length} ${DRY ? "dry" : "sent"}=${ignSendable.length}` +
      (ignAlerts.length ? ` [${ignAlerts.map(lbl).join(",")}]` : "") +
      (watch ? ` | watch checked=${watch.checked}/${watch.eligible} oiBuild=${watch.oiPass} setups=${watch.hits.length}${watchAlerts.length ? " [" + watchAlerts.map(lbl).join(",") + "]" : ""}` : "") +
      ` weight1m=${usedWeight}`,
  );
  try {
    writeJsonAtomic(STATUS_FILE, { at: ts(), pid: process.pid, dryRun: DRY, warm, shortlist: shortlist.length, priceHits: ign.priceHits, evaluated: ign.evaluated.length, confluent: confl.length, sent: DRY ? 0 : ignSendable.length, watch: lastWatchSummary, settings, trigger: TRIG, rules: RULES, weight1m: usedWeight });
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
  process.on("SIGTERM", () => { log("SIGTERM — exiting"); process.exit(0); });
  process.on("SIGINT", () => process.exit(0));
  let backoff = 0;
  for (;;) {
    try {
      await cycle();
      backoff = 0;
    } catch (e) {
      const msg = String(e?.message || e);
      log("cycle error:", msg.slice(0, 200));
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
