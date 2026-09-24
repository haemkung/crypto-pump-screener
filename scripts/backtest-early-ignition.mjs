#!/usr/bin/env node
/**
 * Backtest the early-ignition detector on Binance USDT-M 1m klines.
 *
 *   node scripts/backtest-early-ignition.mjs --cache /workspace/early-bt/k [--hours 24] [--symbols QNTUSDT,BTCUSDT] [--verbose]
 *
 * Cache dir holds <SYMBOL>.json = [[openTime, o, h, l, c, quoteVol], ...] (1m, oldest first).
 * Missing symbols are fetched from www.binance.com (fallback fstream/fapi) and cached.
 * Heuristic only — not financial advice.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import {
  DEFAULT_THRESHOLDS,
  evaluateIgnition,
  gradePath,
  dedupeAllows,
  barsNeeded,
  relMove,
  MAX_PER_CYCLE,
  MIN_REL_MOVE,
} from "./lib/early-ignition-core.mjs";

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const CACHE = arg("cache", "/tmp/early-ignition-bt");
const HOURS = Number(arg("hours", "24"));
const END_MS = arg("end") ? Date.parse(arg("end")) : null;
const VERBOSE = args.includes("--verbose");
const MIN_REL = arg("minRel") ? { long: Number(arg("minRel")), short: Number(arg("minRel")) } : MIN_REL_MOVE;
const TH = { ...DEFAULT_THRESHOLDS, ...JSON.parse(arg("th", "{}")) };
mkdirSync(CACHE, { recursive: true });

const fmt = (t) =>
  new Date(t).toLocaleString("en-GB", { timeZone: "Asia/Bangkok", hour12: false }).slice(0, 17) + " ICT";

const HOSTS = ["https://www.binance.com", "https://fstream.binance.com", "https://fapi.binance.com"];
async function fetchKlines(symbol, startMs, endMs) {
  let all = [];
  let st = startMs;
  while (st < endMs) {
    let got = null;
    for (const h of HOSTS) {
      try {
        const r = await fetch(`${h}/fapi/v1/klines?symbol=${symbol}&interval=1m&startTime=${st}&limit=1500`);
        if (!r.ok) continue;
        got = await r.json();
        break;
      } catch {}
    }
    if (!got || !got.length) break;
    all = all.concat(got.map((x) => [x[0], +x[1], +x[2], +x[3], +x[4], +x[7]]));
    st = got[got.length - 1][0] + 60000;
    if (got.length < 1500) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return all;
}

let symbols = arg("symbols") ? arg("symbols").split(",") : readdirSync(CACHE).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
const data = new Map();
for (const s of symbols) {
  const p = `${CACHE}/${s}.json`;
  if (!existsSync(p)) {
    const end = END_MS ?? Date.now();
    writeFileSync(p, JSON.stringify(await fetchKlines(s, end - (HOURS + 30) * 3600e3, end)));
  }
  const bars = JSON.parse(readFileSync(p, "utf8"));
  if (bars.length > barsNeeded(TH) + 60) data.set(s, bars);
}
const btc = data.get("BTCUSDT") || JSON.parse(readFileSync(`${CACHE}/BTCUSDT.json`, "utf8"));
const btcIdx = new Map(btc.map((b, i) => [b[0], i]));

// Evaluation window: last HOURS of the common data, excluding the still-forming last bar.
let lastT = END_MS ?? Math.max(...[...data.values()].map((b) => b[b.length - 1][0]));
const evalFrom = lastT - HOURS * 3600e3;

const candidates = []; // before dedupe/cap
for (const [s, bars] of data) {
  for (let t = barsNeeded(TH); t < bars.length - 1; t++) {
    const ts = bars[t][0];
    if (ts < evalFrom || ts > lastT) continue;
    // ticker-like 24h stats
    const t24 = t - 1440;
    const ref = t24 >= 0 ? bars[t24][1] : bars[0][1];
    const pct24h = (bars[t][4] / ref - 1) * 100;
    let vol24 = 0;
    for (let i = Math.max(0, t - 1439); i <= t; i++) vol24 += bars[i][5];
    const sig = evaluateIgnition(bars, t, { pct24h, vol24hUsd: vol24 }, TH);
    if (!sig) continue;
    // BTC move over same window
    let btcMove = NaN;
    const bi = btcIdx.get(ts);
    if (bi != null && bi - sig.moveWindow >= 0 && s !== "BTCUSDT") {
      btcMove = (btc[bi][4] / btc[bi - sig.moveWindow][4] - 1) * 100;
    }
    const rel = relMove(sig, btcMove);
    if (s !== "BTCUSDT" && rel < MIN_REL[sig.side]) continue;
    // close time of bar t = ts + 60s ; the daemon sees it on the next cycle.
    candidates.push({ symbol: s, t, ts, sig, rel, bars });
  }
}
candidates.sort((a, b) => a.ts - b.ts || b.sig.score - a.sig.score);

const sent = {};
const alerts = [];
let perMinute = new Map();
const hourWin = [];
for (const c of candidates) {
  const n = perMinute.get(c.ts) || 0;
  if (n >= MAX_PER_CYCLE) continue;
  while (hourWin.length && c.ts - hourWin[0] >= 3600e3) hourWin.shift();
  if (hourWin.length >= 8) continue; // daemon MAX_PER_HOUR
  const fireMs = c.ts + 60_000;
  if (!dedupeAllows(sent, c.symbol, c.sig.side, c.sig.close, fireMs)) continue;
  sent[`${c.symbol}|${c.sig.side}`] = { at: fireMs, price: c.sig.close };
  perMinute.set(c.ts, n + 1);
  hourWin.push(c.ts);
  const g = gradePath(c.bars, c.t, c.sig.side, 3, 2, 240);
  alerts.push({ ...c, g });
}

const graded = alerts.filter((a) => a.g.result === "win" || a.g.result === "loss");
const wins = graded.filter((a) => a.g.result === "win").length;
const byRes = alerts.reduce((m, a) => ((m[a.g.result] = (m[a.g.result] || 0) + 1), m), {});
console.log(`window: ${fmt(evalFrom)} → ${fmt(lastT)}  symbols=${data.size}  thresholds=${JSON.stringify(TH)} minRel=${JSON.stringify(MIN_REL)}`);
console.log(`raw_candidates=${candidates.length} alerts=${alerts.length} long=${alerts.filter((a) => a.sig.side === "long").length} short=${alerts.filter((a) => a.sig.side === "short").length}`);
console.log(`outcomes(side-adjusted +3% before -2%, 4h): ${JSON.stringify(byRes)} hit_rate=${graded.length ? ((wins / graded.length) * 100).toFixed(1) : "n/a"}% (${wins}/${graded.length} decided)`);
for (const sd of ["long", "short"]) {
  const g2 = alerts.filter((a) => a.sig.side === sd && (a.g.result === "win" || a.g.result === "loss"));
  const w2 = g2.filter((a) => a.g.result === "win").length;
  console.log(`  ${sd}: alerts=${alerts.filter((a) => a.sig.side === sd).length} hit=${g2.length ? ((w2 / g2.length) * 100).toFixed(1) : "n/a"}% (${w2}/${g2.length})`);
}
const mfes = alerts.map((a) => a.g.mfe).sort((x, y) => x - y);
if (mfes.length) console.log(`median MFE(4h)=${mfes[Math.floor(mfes.length / 2)].toFixed(2)}%`);
if (VERBOSE || alerts.length <= 60) {
  for (const a of alerts) {
    console.log(
      `${fmt(a.ts + 60000)} ${a.symbol.padEnd(14)} ${a.sig.side.padEnd(5)} px=${a.sig.close} move${a.sig.moveWindow}m=${a.sig.movePct}% fromBase=${a.sig.fromBasePct}% 24h=${a.sig.pct24h.toFixed(1)}% vol×${a.sig.volMult} base=${a.sig.baseRangePct}% rel=${a.rel.toFixed(2)} → ${a.g.result} mfe=${a.g.mfe.toFixed(1)}%`,
    );
  }
}
if (arg("json")) writeFileSync(arg("json"), JSON.stringify(alerts.map(({ bars, ...a }) => a), null, 1));
