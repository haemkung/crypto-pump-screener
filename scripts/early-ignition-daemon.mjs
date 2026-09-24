#!/usr/bin/env node
/**
 * Early-ignition ("เริ่มขยับ / เริ่มทุบ ระยะต้น") Telegram alert daemon.
 *
 * Runs LOCALLY (never on Workers). Every ~60s:
 *   1. one /fapi/v1/ticker/24hr call (weight 40) → in-memory price snapshots
 *   2. shortlist symbols moving >= SHORTLIST_PCT over 5-15 min with modest 24h change
 *   3. 1m klines (limit ~262, weight 2) only for the shortlist (cap KLINE_CAP)
 *   4. detector in lib/early-ignition-core.mjs; bonus OI / funding lookups for hits only
 *   5. dedupe (2h/symbol/side unless new +3% leg), max 3 per cycle, max 8 per hour
 *   6. Telegram via scripts/send-telegram.mjs (TELEGRAM_BOT_TOKEN env + .telegram-chat-id)
 *   7. log to data/early-alerts.json and self-grade outcomes (5m/15m/60m + "+3% before -2%" in 4h)
 *
 * WATCH tier (every 5 min, rotating batch, /futures/data endpoints only for the batch/hits):
 *   👀 กำลังสะสม (long watch): flat price 3h + OI rising
 *   👀 กำลังแจกของ (short watch): already-pumped coin stalling below its 24h high + OI rising
 *   enriched with funding, global/top-trader long-short ratio, taker buy/sell ratio, spot volume.
 *
 * Per-tier/side Telegram switches live in data/early-alert-settings.json (created with defaults):
 *   sendIgnitionLong / sendIgnitionShort / sendWatchLong / sendWatchShort, maxIgnitionPer24h, maxWatchPer24h.
 * Suppressed tiers are still logged + graded (delivered=false, suppressed=<reason>).
 *
 * Flags / env:
 *   --once            run one cycle and exit
 *   --dry-run         never send Telegram, never write dedupe state / alert log (EARLY_DRY_RUN=1)
 *   EARLY_INTERVAL_MS default 60000
 *
 * Heuristic only — not financial advice.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_THRESHOLDS,
  evaluateIgnition,
  gradePath,
  dedupeAllows,
  barsNeeded,
  relMove,
  MAX_PER_CYCLE,
  DEDUPE_MS,
  WATCH_THRESHOLDS,
  MIN_REL_MOVE,
  evaluateWatch,
  gradePath5,
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

/** Telegram switches. Short tiers default OFF until live/backtest hit rate is acceptable. */
const DEFAULT_SETTINGS = {
  sendIgnitionLong: true,
  sendIgnitionShort: false,
  sendWatchLong: true,
  sendWatchShort: false,
  maxWatchPer24h: 10,
  maxIgnitionPer24h: 20,
};
function loadSettings() {
  let raw = null;
  try {
    raw = existsSync(SETTINGS_FILE) ? JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) : null;
  } catch {}
  if (!raw || typeof raw !== "object") {
    raw = { ...DEFAULT_SETTINGS, note: "early-ignition daemon Telegram switches; short tiers off until backtest/live hit rate is reasonable", updatedAt: new Date().toISOString() };
    try { writeJsonAtomic(SETTINGS_FILE, raw); } catch {}
  }
  const out = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (typeof raw[k] === typeof DEFAULT_SETTINGS[k]) out[k] = raw[k];
  return out;
}

const ONCE = process.argv.includes("--once");
const DRY = process.argv.includes("--dry-run") || process.env.EARLY_DRY_RUN === "1";
const INTERVAL_MS = Number(process.env.EARLY_INTERVAL_MS || 60_000);

const TH = { ...DEFAULT_THRESHOLDS };

/** shortlist gate from ticker snapshots (looser than the detector) */
const SHORTLIST_PCT = 1.0;
const KLINE_CAP = 40;
const MAX_PER_HOUR = 8;
const SNAP_KEEP_MS = 4 * 60 * 60 * 1000 + 5 * 60 * 1000;
const WATCH_TH = { ...WATCH_THRESHOLDS };
/** max symbols per 5-min watch cycle (1 openInterestHist call each; /futures/data limit is 1000 req / 5 min per IP) */
const WATCH_BATCH = 120;
const WATCH_DEDUPE_MS = 4 * 3600e3;
const WATCH_MAX_PER_CYCLE = 2;
/** ignition message mentions a prior watch flag within this window */
const WATCH_MENTION_MS = 12 * 3600e3;
const LOG_KEEP = 1000;

const HOSTS = ["https://www.binance.com", "https://fstream.binance.com", "https://fapi.binance.com"];
const HEADERS = {
  Accept: "application/json",
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) crypto-pump-screener-early/1.0",
};
let usedWeight = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** local ISO time with offset (box runs Asia/Bangkok), e.g. 2026-09-25T02:40:00+07:00 */
const ts = () => {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const local = new Date(d.getTime() + off * 60e3).toISOString().slice(0, 19);
  const sign = off >= 0 ? "+" : "-";
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
  const mm = String(Math.abs(off) % 60).padStart(2, "0");
  return `${local}${sign}${hh}:${mm}`;
};
const log = (...a) => console.log(`[${ts()}]`, ...a);

async function fapi(path, timeoutMs = 10_000) {
  let lastErr;
  for (const h of HOSTS) {
    try {
      const r = await fetch(h + path, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
      const w = Number(r.headers.get("x-mbx-used-weight-1m"));
      if (Number.isFinite(w) && w > 0) usedWeight = w;
      if (!r.ok) {
        lastErr = new Error(`HTTP ${r.status} ${h}${path.split("?")[0]}`);
        if (r.status === 429 || r.status === 418) throw lastErr; // back off, don't hammer other hosts
        continue;
      }
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (String(e).includes("HTTP 429") || String(e).includes("HTTP 418")) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function readJson(p, fb) {
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fb;
  } catch {
    return fb;
  }
}
function writeJsonAtomic(p, v) {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(v, null, 1) + "\n", "utf8");
  renameSync(tmp, p);
}

// ---------- perpetual universe (refresh hourly) ----------
let perpSet = null;
let perpAt = 0;
async function refreshPerps() {
  if (perpSet && Date.now() - perpAt < 3600e3) return;
  try {
    const info = await fapi("/fapi/v1/exchangeInfo", 20_000);
    perpSet = new Set(
      info.symbols
        .filter((s) => s.contractType === "PERPETUAL" && s.quoteAsset === "USDT" && s.status === "TRADING")
        .map((s) => s.symbol),
    );
    perpAt = Date.now();
  } catch (e) {
    if (!perpSet) log("exchangeInfo failed (fallback to suffix filter):", String(e));
  }
}
const isPerp = (s) => (perpSet ? perpSet.has(s) : s.endsWith("USDT") && !s.includes("_"));

// ---------- snapshots ----------
/** symbol -> [{t, p}] */
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

/** price range % over the last `mins` minutes from snapshots, or null if not enough history */
function snapRange(sym, now, mins) {
  const a = snaps.get(sym);
  if (!a || !a.length || now - a[0].t < (mins - 5) * 60e3) return null;
  let hi = -Infinity, lo = Infinity;
  for (const s of a) if (now - s.t <= mins * 60e3) { if (s.p > hi) hi = s.p; if (s.p < lo) lo = s.p; }
  return lo > 0 ? ((hi - lo) / lo) * 100 : null;
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
function fmtIct(ms) {
  return new Date(ms).toLocaleTimeString("en-GB", { timeZone: "Asia/Bangkok", hour12: false }).slice(0, 5);
}

function formatAlert(a) {
  const head = a.side === "long" ? "🚀 เริ่มขยับ (ระยะต้น)" : "🔻 เริ่มทุบ (ระยะต้น)";
  const lines = [
    `${head} · ${a.symbol}`,
    `ราคา ${fmtPrice(a.price)} | ${a.moveWindow}m ${fmtPct(a.movePct)} | จากฐาน ${fmtPct(a.fromBasePct)} | 24h ${fmtPct(a.pct24h)}`,
    `วอลุ่ม ×${a.volMult} (5m เทียบเฉลี่ย 1h) | ${a.side === "long" ? "ทะลุกรอบ 4h บน" : "หลุดกรอบ 4h ล่าง"} ${fmtPct(a.breakoutPct)} | ฐานแคบ ${a.baseRangePct}%`,
  ];
  const extra = [];
  if (Number.isFinite(a.oiChange30mPct)) extra.push(`OI 30m ${fmtPct(a.oiChange30mPct)}`);
  if (Number.isFinite(a.fundingPct)) extra.push(`funding ${a.fundingPct.toFixed(4)}%`);
  if (extra.length) lines.push(extra.join(" | "));
  if (a.watchFlag) {
    const hrs = (a.watchFlag.agoMin / 60).toFixed(1);
    lines.push(`👀 เคยติด "${a.watchFlag.tier === "accumulation" ? "กำลังสะสม" : "กำลังแจกของ"}" เมื่อ ${hrs} ชม.ก่อน`);
  }
  lines.push(`เวลา ${fmtIct(a.barCloseMs)} ICT · score ${a.score}`);
  return lines.join("\n");
}

function formatWatch(w) {
  const head = w.tier === "accumulation" ? "👀 กำลังสะสม (เฝ้าดู)" : "👀 กำลังแจกของ (เฝ้าดู Short)";
  const lines = [
    `${head} · ${w.symbol}`,
    `ราคา ${fmtPrice(w.price)} | กรอบราคา ${w.windowHours}h ${w.rangePct}% | OI ${fmtPct(w.oiChangePct)} (${w.windowHours}h) | 24h ${fmtPct(w.pct24h)}`,
  ];
  if (w.tier === "distribution") lines.push(`พุ่งมาแล้ว ${w.pumpPct}% ใน 24h · ต่ำกว่ายอด ${w.belowHighPct}% (ทำ high ใหม่ไม่ได้)`);
  const x = [];
  if (Number.isFinite(w.fundingPct)) x.push(`funding ${w.fundingPct.toFixed(4)}%`);
  if (Number.isFinite(w.globalLs)) x.push(`L/S ทั่วไป ${w.globalLs.toFixed(2)}`);
  if (Number.isFinite(w.topLs)) x.push(`L/S รายใหญ่ ${w.topLs.toFixed(2)}`);
  if (x.length) lines.push(x.join(" | "));
  const y = [];
  if (Number.isFinite(w.takerRatio1h)) y.push(`taker buy/sell 1h ${w.takerRatio1h.toFixed(2)}` + (Number.isFinite(w.takerRatioPrev) ? ` (ก่อนหน้า ${w.takerRatioPrev.toFixed(2)})` : ""));
  if (Number.isFinite(w.spotVolMult)) y.push(`spot vol ×${w.spotVolMult.toFixed(1)}` + (Number.isFinite(w.spotTakerBuyPct) ? ` · spot ซื้อ ${w.spotTakerBuyPct.toFixed(0)}%` : ""));
  if (y.length) lines.push(y.join(" | "));
  lines.push(`เวลา ${fmtIct(w.ts)} ICT · score ${w.score}`);
  return lines.join("\n");
}

// ---------- bonus signals (only for hits) ----------
async function enrich(sig) {
  try {
    const oi = await fapi(`/futures/data/openInterestHist?symbol=${sig.symbol}&period=5m&limit=7`);
    if (Array.isArray(oi) && oi.length >= 2) {
      const a = Number(oi[0].sumOpenInterest);
      const b = Number(oi[oi.length - 1].sumOpenInterest);
      if (a > 0 && b > 0) sig.oiChange30mPct = Math.round((b / a - 1) * 10000) / 100;
    }
  } catch {}
  try {
    const pi = await fapi(`/fapi/v1/premiumIndex?symbol=${sig.symbol}`);
    const f = Number(pi?.lastFundingRate);
    if (Number.isFinite(f)) sig.fundingPct = f * 100;
  } catch {}
  if (Number.isFinite(sig.oiChange30mPct)) {
    if (sig.oiChange30mPct >= 2) sig.score += 10;
    else if (sig.oiChange30mPct >= 0.5) sig.score += 5;
  }
  if (Number.isFinite(sig.fundingPct)) {
    // heavy shorts paying into a pump / crowded longs into a dump
    if (sig.side === "long" && sig.fundingPct < -0.02) sig.score += 5;
    if (sig.side === "short" && sig.fundingPct > 0.03) sig.score += 5;
  }
}

// ---------- telegram ----------
function sendTelegram(text) {
  if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) return { ok: false, err: "TELEGRAM_BOT_TOKEN not set" };
  if (!existsSync(CHAT_ID_FILE)) return { ok: false, err: "missing .telegram-chat-id" };
  const r = spawnSync(process.execPath, [resolve(__dirname, "send-telegram.mjs"), text], {
    env: process.env,
    encoding: "utf8",
    timeout: 20_000,
  });
  return r.status === 0 ? { ok: true } : { ok: false, err: (r.stderr || r.stdout || "").trim().slice(0, 200) };
}

// ---------- outcome grading ----------
const HORIZONS = { "5m": [5, 0.8], "15m": [15, 1.5], "60m": [60, 3.0] };
async function gradeOpen(logObj, priceMap, now) {
  let changed = false;
  for (const a of logObj.alerts) {
    if (!a.outcomes) a.outcomes = { "5m": null, "15m": null, "60m": null };
    const age = now - Date.parse(a.sentAt);
    const px = priceMap.get(a.symbol);
    for (const [h, [mins, thr]] of Object.entries(HORIZONS)) {
      if (a.outcomes[h] != null || age < mins * 60e3 || !(px > 0)) continue;
      // grade within 3 min of horizon, otherwise mark stale (daemon was down)
      if (age > (mins + 3) * 60e3) {
        a.outcomes[h] = "missed";
      } else {
        const move = (px / a.price - 1) * 100;
        const sm = a.side === "long" ? move : -move;
        a.outcomes[h] = sm >= thr ? "win" : sm <= -thr ? "loss" : "neutral";
        (a.moves ||= {})[h] = Math.round(move * 100) / 100;
      }
      changed = true;
    }
    if (!a.path && a.type === "watch" && age >= 8 * 3600e3 + 5 * 60e3) {
      try {
        const k = await fapi(`/fapi/v1/klines?symbol=${a.symbol}&interval=5m&startTime=${a.barCloseMs - 300e3}&limit=98`);
        const p5 = k.map((x) => [x[0], +x[2], +x[3], +x[4]]);
        if (p5.length > 10) {
          const g = gradePath5(p5, 0, a.side, 3, 2, 96);
          a.path = { rule: a.side === "long" ? "+3% before -2% within 8h" : "-3% before +2% within 8h", result: g.result, bars5m: g.bars, mfePct: Math.round(g.mfe * 100) / 100 };
          changed = true;
        }
      } catch {}
      continue;
    }
    if (a.type === "watch") continue;
    if (!a.path && age >= 4 * 3600e3 + 60e3) {
      try {
        const k = await fapi(`/fapi/v1/klines?symbol=${a.symbol}&interval=1m&startTime=${a.barCloseMs - 60e3}&limit=242`);
        const bars = k.map((x) => [x[0], +x[1], +x[2], +x[3], +x[4], +x[7]]);
        if (bars.length > 10) {
          const g = gradePath(bars, 0, a.side, 3, 2, 240);
          a.path = { rule: a.side === "long" ? "+3% before -2% within 4h" : "-3% before +2% within 4h", result: g.result, bars: g.bars, mfePct: Math.round(g.mfe * 100) / 100 };
          changed = true;
        }
      } catch {}
    }
  }
  if (changed) {
    const stats = { updatedAt: ts(), total: logObj.alerts.length };
    for (const type of ["early", "watch"]) {
      for (const side of ["long", "short"]) {
        const done = logObj.alerts.filter((a) => (a.type || "early") === type && a.side === side && a.path && (a.path.result === "win" || a.path.result === "loss"));
        const wins = done.filter((a) => a.path.result === "win").length;
        stats[`${type}_${side}`] = { decided: done.length, wins, hitRate: done.length ? Math.round((wins / done.length) * 1000) / 1000 : null };
      }
    }
    logObj.stats = stats;
  }
  return changed;
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
    if (mv == null || Math.abs(mv) < SHORTLIST_PCT) continue;
    if (!(vol24 >= TH.min24hVolUsd)) continue;
    if (mv > 0 && !(pct24h < TH.max24hAbsPct + 1 && pct24h > -TH.opposite24hLimitPct)) continue;
    if (mv < 0 && !(pct24h > -TH.max24hAbsPct - 1 && pct24h < TH.opposite24hLimitPct)) continue;
    shortlist.push({ s, mv, pct24h, vol24 });
  }
  shortlist.sort((a, b) => Math.abs(b.mv) - Math.abs(a.mv));
  const picked = shortlist.slice(0, KLINE_CAP);

  const state = readJson(STATE_FILE, { sent: {} });
  state.sent ||= {};
  for (const [k, v] of Object.entries(state.sent)) if (!v || now - v.at > DEDUPE_MS * 2) delete state.sent[k];
  state.recent = (state.recent || []).filter((x) => now - x < 3600e3);
  state.recent24h = (state.recent24h || []).filter((x) => now - x < 24 * 3600e3);
  state.watchSent ||= {};
  for (const [k, v] of Object.entries(state.watchSent)) if (!v || now - v > WATCH_DEDUPE_MS * 2) delete state.watchSent[k];
  state.watchRecent = (state.watchRecent || []).filter((x) => now - x < 24 * 3600e3);
  state.watchFlags ||= {};
  for (const [k, v] of Object.entries(state.watchFlags)) if (!v || now - v.at > WATCH_MENTION_MS) delete state.watchFlags[k];

  // BTC reference for relative move
  let btcBars = null;
  if (picked.length) {
    try {
      btcBars = (await fapi(`/fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=20`)).map((x) => [x[0], +x[1], +x[2], +x[3], +x[4], +x[7]]);
    } catch {}
  }

  const need = barsNeeded(TH) + 2;
  const hits = [];
  for (let i = 0; i < picked.length; i += 8) {
    const chunk = picked.slice(i, i + 8);
    await Promise.all(
      chunk.map(async (c) => {
        try {
          const raw = await fapi(`/fapi/v1/klines?symbol=${c.s}&interval=1m&limit=${need}`);
          let bars = raw.map((x) => [x[0], +x[1], +x[2], +x[3], +x[4], +x[7]]);
          // drop the still-forming bar
          while (bars.length && bars[bars.length - 1][0] + 60e3 > Date.now()) bars.pop();
          if (bars.length < barsNeeded(TH)) return;
          // evaluate the last 2 closed bars (covers a slightly late cycle); prefer latest
          for (const t of [bars.length - 1, bars.length - 2]) {
            const sig = evaluateIgnition(bars, t, { pct24h: c.pct24h, vol24hUsd: c.vol24 }, TH);
            if (!sig) continue;
            let btcMove = NaN;
            if (btcBars && c.s !== "BTCUSDT") {
              const bi = btcBars.findIndex((b) => b[0] === bars[t][0]);
              if (bi >= sig.moveWindow) btcMove = (btcBars[bi][4] / btcBars[bi - sig.moveWindow][4] - 1) * 100;
            }
            const rel = relMove(sig, btcMove);
            if (c.s !== "BTCUSDT" && rel < MIN_REL_MOVE[sig.side]) continue;
            hits.push({ ...sig, symbol: c.s, relMovePct: Math.round(rel * 100) / 100, btcMovePct: Number.isFinite(btcMove) ? Math.round(btcMove * 100) / 100 : null, barCloseMs: bars[t][0] + 60e3 });
            break;
          }
        } catch (e) {
          if (String(e).includes("429") || String(e).includes("418")) throw e;
        }
      }),
    );
    if (usedWeight > 1500) break; // leave headroom for the Next app sharing this IP
  }

  // dedupe + caps (suppressed = logged/graded but not sent, per settings)
  const fresh = [];
  for (const h of hits) {
    if (!dedupeAllows(state.sent, h.symbol, h.side, h.close, now)) continue;
    h.suppressed = h.side === "long" ? (settings.sendIgnitionLong ? null : "long_disabled") : settings.sendIgnitionShort ? null : "short_disabled";
    const wf = state.watchFlags[h.symbol];
    if (wf && wf.side === h.side && now - wf.at <= WATCH_MENTION_MS) h.watchFlag = { tier: wf.tier, agoMin: Math.round((now - wf.at) / 60e3) };
    fresh.push(h);
  }
  for (const h of fresh) await enrich(h);
  fresh.sort((a, b) => b.score - a.score);
  const room = Math.max(0, Math.min(MAX_PER_CYCLE, MAX_PER_HOUR - state.recent.length, settings.maxIgnitionPer24h - state.recent24h.length));
  const toSend = [
    ...fresh.filter((h) => !h.suppressed).slice(0, room),
    ...fresh.filter((h) => h.suppressed).slice(0, MAX_PER_CYCLE),
  ];

  const alerts = toSend.map((h) => ({
    id: randomUUID(),
    type: "early",
    symbol: h.symbol,
    side: h.side,
    sentAt: new Date(now).toISOString(),
    barCloseMs: h.barCloseMs,
    price: h.close,
    movePct: h.movePct,
    moveWindow: h.moveWindow,
    fromBasePct: h.fromBasePct,
    pct24h: Math.round(h.pct24h * 100) / 100,
    volMult: h.volMult,
    vol5mUsd: h.vol5mUsd,
    baseRangePct: h.baseRangePct,
    breakoutPct: h.breakoutPct,
    relMovePct: h.relMovePct,
    btcMovePct: h.btcMovePct,
    oiChange30mPct: h.oiChange30mPct ?? null,
    fundingPct: h.fundingPct != null ? Math.round(h.fundingPct * 10000) / 10000 : null,
    watchFlag: h.watchFlag || null,
    score: h.score,
    suppressed: h.suppressed || null,
    delivered: false,
    dryRun: DRY,
    outcomes: { "5m": null, "15m": null, "60m": null },
  }));

  let sendResult = null;
  const logObj = readJson(LOG_FILE, { alerts: [] });
  logObj.alerts ||= [];
  const sendable = alerts.filter((a) => !a.suppressed);
  if (alerts.length) {
    const body =
      `แจ้งเตือน crypto-pump-screener · ระยะต้น (${sendable.length})\n` +
      `สัญญาณระยะต้น เสี่ยงหลอกสูงกว่า ไม่ใช่คำแนะนำการลงทุน\n—\n\n` +
      sendable.map(formatAlert).join("\n\n");
    if (DRY) {
      if (sendable.length) log("DRY-RUN would send:\n" + body);
      for (const a of alerts.filter((x) => x.suppressed)) log(`DRY-RUN suppressed (${a.suppressed}): ${a.symbol} ${a.side}`);
    } else {
      // log BEFORE sending so learning never depends on delivery
      logObj.alerts.push(...alerts);
      if (sendable.length) {
        sendResult = sendTelegram(body);
        if (sendResult.ok) for (const a of sendable) a.delivered = true;
        else log("telegram send failed:", sendResult.err);
      }
      for (const a of alerts) {
        state.sent[`${a.symbol}|${a.side}`] = { at: now, price: a.price };
        if (!a.suppressed) { state.recent.push(now); state.recent24h.push(now); }
      }
    }
  }

  // ---- WATCH tier: once per 5-min slot, >= 60s into the slot so the last OI bucket is published
  let watchSummary = null;
  const slot = Math.floor(now / 300e3);
  if (slot !== lastWatchSlot && now % 300e3 >= 55e3) {
    lastWatchSlot = slot;
    try {
      watchSummary = await watchCycle(tickMap, state, logObj, settings, now);
    } catch (e) {
      log("watch cycle error:", String(e?.message || e).slice(0, 200));
    }
  }

  if (!DRY) {
    await gradeOpen(logObj, priceMap, now);
    if (logObj.alerts.length > LOG_KEEP) logObj.alerts = logObj.alerts.slice(-LOG_KEEP);
    writeJsonAtomic(LOG_FILE, logObj);
    writeJsonAtomic(STATE_FILE, state);
  }

  const summary = {
    at: ts(),
    ms: Date.now() - t0,
    tickers: priceMap.size,
    warm,
    shortlist: shortlist.length,
    klines: picked.length,
    hits: hits.length,
    fresh: fresh.length,
    sent: DRY ? 0 : sendable.length,
    alerts: alerts.map((a) => `${a.symbol}:${a.side}${a.suppressed ? "(suppressed)" : ""}`),
    delivered: sendResult ? sendResult.ok : null,
    watch: watchSummary || lastWatchSummary,
    weight1m: usedWeight,
    dryRun: DRY,
    settings,
  };
  if (watchSummary) lastWatchSummary = watchSummary;
  log(
    `cycle ms=${summary.ms} tickers=${summary.tickers} warm=${warm} shortlist=${summary.shortlist} klines=${summary.klines} hits=${summary.hits} fresh=${summary.fresh} ${DRY ? "dry" : "sent"}=${sendable.length}${alerts.length ? " [" + summary.alerts.join(",") + "]" : ""}` +
      (watchSummary ? ` | watch checked=${watchSummary.checked} eligible=${watchSummary.eligible} hits=${watchSummary.hits} ${DRY ? "dry" : "sent"}=${watchSummary.sent}${watchSummary.list.length ? " [" + watchSummary.list.join(",") + "]" : ""}` : "") +
      ` weight1m=${usedWeight}`,
  );
  try {
    writeJsonAtomic(STATUS_FILE, { ...summary, pid: process.pid, intervalMs: INTERVAL_MS, thresholds: TH, watchThresholds: WATCH_TH, minRelMove: MIN_REL_MOVE });
  } catch {}
}

// ---------- WATCH tier ----------
let lastWatchSlot = null;
let lastWatchSummary = null;
/** symbol -> last OI check ms (rotation) */
const watchChecked = new Map();
let fundingCache = { at: 0, map: new Map() };

async function fundingMap() {
  if (Date.now() - fundingCache.at < 240e3) return fundingCache.map;
  const pi = await fapi("/fapi/v1/premiumIndex", 15_000);
  const m = new Map();
  for (const x of pi) m.set(x.symbol, Number(x.lastFundingRate) * 100);
  fundingCache = { at: Date.now(), map: m };
  return m;
}

async function enrichWatch(w) {
  try { w.fundingPct = (await fundingMap()).get(w.symbol); } catch {}
  try {
    const g = await fapi(`/futures/data/globalLongShortAccountRatio?symbol=${w.symbol}&period=5m&limit=1`);
    w.globalLs = Number(g?.[0]?.longShortRatio);
  } catch {}
  try {
    const t = await fapi(`/futures/data/topLongShortPositionRatio?symbol=${w.symbol}&period=5m&limit=1`);
    w.topLs = Number(t?.[0]?.longShortRatio);
  } catch {}
  try {
    const tk = await fapi(`/futures/data/takerlongshortRatio?symbol=${w.symbol}&period=5m&limit=36`);
    if (Array.isArray(tk) && tk.length >= 24) {
      const sum = (arr) => { let b = 0, s = 0; for (const x of arr) { b += +x.buyVol; s += +x.sellVol; } return s > 0 ? b / s : null; };
      w.takerRatio1h = sum(tk.slice(-12));
      w.takerRatioPrev = sum(tk.slice(0, -12));
    }
  } catch {}
  try {
    const spotSym = w.symbol.replace(/^1000+/, "");
    const r = await fetch(`https://www.binance.com/api/v3/klines?symbol=${spotSym}&interval=5m&limit=36`, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const k = await r.json();
      if (Array.isArray(k) && k.length >= 24) {
        const last = k.slice(-12), prev = k.slice(0, -12);
        const v = (a) => a.reduce((s, x) => s + +x[7], 0);
        const vl = v(last), vp = v(prev) / (prev.length / 12);
        if (vp > 0) w.spotVolMult = vl / vp;
        if (vl > 0) w.spotTakerBuyPct = (last.reduce((s, x) => s + +x[10], 0) / vl) * 100;
      }
    }
  } catch {}
  // score
  let sc = 50;
  sc += Math.min(20, Math.max(0, (w.oiChangePct - 5) * 2));
  if (w.tier === "accumulation") {
    if (Number.isFinite(w.fundingPct) && w.fundingPct < 0) sc += 10;
    if (Number.isFinite(w.globalLs) && w.globalLs < 1) sc += 10; // crowded shorts
    if (Number.isFinite(w.takerRatio1h) && Number.isFinite(w.takerRatioPrev) && w.takerRatio1h > w.takerRatioPrev * 1.1) sc += 5;
    if (Number.isFinite(w.spotVolMult) && w.spotVolMult > 1.5) sc += 5;
  } else {
    if (Number.isFinite(w.fundingPct) && w.fundingPct > 0.02) sc += 10;
    if ((Number.isFinite(w.globalLs) && w.globalLs > 2) || (Number.isFinite(w.topLs) && w.topLs > 2)) sc += 10; // crowded longs
    if (Number.isFinite(w.takerRatio1h) && Number.isFinite(w.takerRatioPrev) && w.takerRatio1h < w.takerRatioPrev * 0.9) sc += 5;
    if (Number.isFinite(w.spotTakerBuyPct) && w.spotTakerBuyPct < 45) sc += 5;
  }
  w.score = Math.round(sc);
}

async function watchCycle(tickMap, state, logObj, settings, now) {
  const W = WATCH_TH.windowBars;
  const elig = [];
  for (const [s, t] of tickMap) {
    if (!(t.vol24 >= WATCH_TH.min24hVolUsd)) continue;
    const pump = t.low24 > 0 ? (t.high24 / t.low24 - 1) * 100 : 0;
    const aboveLow = t.low24 > 0 ? (t.p / t.low24 - 1) * 100 : 0;
    const acc = Math.abs(t.pct24h) < WATCH_TH.accMax24hAbsPct;
    const dist = pump >= WATCH_TH.distMinPumpPct && aboveLow >= WATCH_TH.distMinAboveLowPct;
    if (!acc && !dist) continue;
    const r = snapRange(s, now, (W * 5));
    if (r != null) {
      const okAcc = acc && r <= WATCH_TH.accMaxRangePct + 0.5;
      const okDist = dist && r <= WATCH_TH.distMaxRangePct + 0.5;
      if (!okAcc && !okDist) continue;
    }
    elig.push(s);
  }
  elig.sort((a, b) => (watchChecked.get(a) || 0) - (watchChecked.get(b) || 0));
  const batch = elig.slice(0, WATCH_BATCH);
  const hits = [];
  let checked = 0;
  for (let i = 0; i < batch.length; i += 4) {
    const chunk = batch.slice(i, i + 4);
    await Promise.all(chunk.map(async (s) => {
      try {
        const raw = await fapi(`/futures/data/openInterestHist?symbol=${s}&period=5m&limit=${W + 2}`);
        watchChecked.set(s, Date.now());
        checked++;
        if (!Array.isArray(raw) || raw.length < W + 1) return;
        const pts = raw.map((x) => [Number(x.timestamp), Number(x.sumOpenInterest), Number(x.sumOpenInterestValue)]).sort((a, b) => a[0] - b[0]).slice(-(W + 1));
        const oi5 = pts.map((x) => [x[0], x[1]]);
        const price5 = pts.map((x) => { const p = x[1] > 0 ? x[2] / x[1] : NaN; return [x[0], p, p, p]; });
        const t = tickMap.get(s);
        const day = { high24: t.high24, low24: t.low24, pct24h: t.pct24h, vol24hUsd: t.vol24 };
        if (!evaluateWatch(price5, oi5, day, WATCH_TH)) return;
        // confirm with real 5m highs/lows aligned to the OI timestamps
        const k = await fapi(`/fapi/v1/klines?symbol=${s}&interval=5m&limit=${W + 3}`);
        const km = new Map(k.map((x) => [Number(x[0]), [Number(x[0]), +x[2], +x[3], +x[4]]]));
        const p5 = oi5.map((o) => km.get(o[0]));
        if (p5.some((x) => !x)) return;
        const sig = evaluateWatch(p5, oi5, day, WATCH_TH);
        if (sig) hits.push({ ...sig, symbol: s, price: t.p });
      } catch (e) {
        if (String(e).includes("429") || String(e).includes("418")) throw e;
      }
    }));
    await sleep(120);
  }

  const fresh = [];
  for (const h of hits) {
    const key = `${h.symbol}|${h.tier}`;
    if (state.watchSent[key] && now - state.watchSent[key] < WATCH_DEDUPE_MS) continue;
    h.suppressed = h.side === "long" ? (settings.sendWatchLong ? null : "long_disabled") : settings.sendWatchShort ? null : "short_disabled";
    fresh.push(h);
  }
  for (const h of fresh) await enrichWatch(h);
  fresh.sort((a, b) => b.score - a.score);
  const room = Math.max(0, Math.min(WATCH_MAX_PER_CYCLE, settings.maxWatchPer24h - state.watchRecent.length));
  const chosen = [...fresh.filter((h) => !h.suppressed).slice(0, room), ...fresh.filter((h) => h.suppressed).slice(0, WATCH_MAX_PER_CYCLE)];
  const alerts = chosen.map((h) => ({
    id: randomUUID(),
    type: "watch",
    tier: h.tier,
    symbol: h.symbol,
    side: h.side,
    sentAt: new Date(now).toISOString(),
    barCloseMs: h.ts + 300e3,
    ts: now,
    price: h.price,
    rangePct: h.rangePct,
    windowHours: h.windowHours,
    oiChangePct: h.oiChangePct,
    oiWindowPct: h.oiWindowPct,
    pct24h: Math.round(h.pct24h * 100) / 100,
    pumpPct: h.pumpPct ?? null,
    belowHighPct: h.belowHighPct ?? null,
    fundingPct: Number.isFinite(h.fundingPct) ? Math.round(h.fundingPct * 10000) / 10000 : null,
    globalLs: Number.isFinite(h.globalLs) ? h.globalLs : null,
    topLs: Number.isFinite(h.topLs) ? h.topLs : null,
    takerRatio1h: Number.isFinite(h.takerRatio1h) ? Math.round(h.takerRatio1h * 1000) / 1000 : null,
    takerRatioPrev: Number.isFinite(h.takerRatioPrev) ? Math.round(h.takerRatioPrev * 1000) / 1000 : null,
    spotVolMult: Number.isFinite(h.spotVolMult) ? Math.round(h.spotVolMult * 100) / 100 : null,
    spotTakerBuyPct: Number.isFinite(h.spotTakerBuyPct) ? Math.round(h.spotTakerBuyPct * 10) / 10 : null,
    score: h.score,
    suppressed: h.suppressed || null,
    delivered: false,
    dryRun: DRY,
    outcomes: { "5m": null, "15m": null, "60m": null },
  }));
  const sendable = alerts.filter((a) => !a.suppressed);
  let sentOk = null;
  if (alerts.length) {
    const body =
      `แจ้งเตือน crypto-pump-screener · เฝ้าดู (${sendable.length})\n` +
      `รายการเฝ้าดู ยังไม่ใช่จุดเข้า · ไม่ใช่คำแนะนำการลงทุน\n—\n\n` +
      sendable.map(formatWatch).join("\n\n");
    if (DRY) {
      if (sendable.length) log("DRY-RUN would send (watch):\n" + body);
      for (const a of alerts.filter((x) => x.suppressed)) log(`DRY-RUN watch suppressed (${a.suppressed}): ${a.symbol} ${a.tier}`);
    } else {
      logObj.alerts.push(...alerts);
      if (sendable.length) {
        const r = sendTelegram(body);
        sentOk = r.ok;
        if (r.ok) for (const a of sendable) a.delivered = true;
        else log("telegram watch send failed:", r.err);
      }
      for (const a of alerts) {
        state.watchSent[`${a.symbol}|${a.tier}`] = now;
        state.watchFlags[a.symbol] = { tier: a.tier, side: a.side, at: now };
        if (!a.suppressed) state.watchRecent.push(now);
      }
    }
  }
  return { at: ts(), eligible: elig.length, checked, hits: hits.length, fresh: fresh.length, sent: DRY ? 0 : sendable.length, delivered: sentOk, list: alerts.map((a) => `${a.symbol}:${a.tier}${a.suppressed ? "(suppressed)" : ""}`) };
}

async function main() {
  log(`early-ignition daemon start pid=${process.pid} dryRun=${DRY} once=${ONCE} interval=${INTERVAL_MS}ms`);
  let stop = false;
  process.on("SIGTERM", () => { stop = true; log("SIGTERM — exiting"); process.exit(0); });
  process.on("SIGINT", () => { stop = true; process.exit(0); });
  let backoff = 0;
  while (!stop) {
    try {
      await cycle();
      backoff = 0;
    } catch (e) {
      const msg = String(e?.message || e);
      log("cycle error:", msg.slice(0, 200));
      if (msg.includes("429") || msg.includes("418")) backoff = Math.min(600_000, (backoff || 60_000) * 2);
    }
    if (ONCE) break;
    // align to ~4s after the next minute boundary so the last 1m bar is closed
    const nowMs = Date.now();
    let wait = (64_000 - (nowMs % 60_000)) % 60_000;
    if (wait < 5_000) wait += 60_000;
    if (INTERVAL_MS !== 60_000) wait = INTERVAL_MS;
    await sleep(wait + backoff);
  }
}

main();
