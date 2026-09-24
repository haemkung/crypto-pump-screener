#!/usr/bin/env node
/**
 * Backtest the WATCH tier (👀 กำลังสะสม / 👀 กำลังแจกของ) from cached data.
 *
 *   node scripts/backtest-early-watch.mjs --k1 <dir of 1m klines> --oi <dir of 5m OI> [--hours 24] [--end ISO] [--th '{...}'] [--verbose]
 *
 * 1m kline files: [[openTime,o,h,l,c,quoteVol],...]; OI files: [[ts,sumOpenInterest,sumOpenInterestValue],...]
 * Grades: accumulation = +3% before -2% within 8h; distribution = -3% before +2% within 8h.
 * Also prints a naive baseline (every 5m bar, same universe) for comparison.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { WATCH_THRESHOLDS, evaluateWatch, gradePath5 } from "./lib/early-ignition-core.mjs";

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const K1 = arg("k1"); const OI = arg("oi");
const HOURS = Number(arg("hours", "24"));
const TH = { ...WATCH_THRESHOLDS, ...JSON.parse(arg("th", "{}")) };
const VERBOSE = args.includes("--verbose");
const ONLY = arg("symbols") ? new Set(arg("symbols").split(",")) : null;
const DEDUPE_MS = 4 * 3600e3;
const fmt = (t) => new Date(t).toLocaleString("en-GB", { timeZone: "Asia/Bangkok", hour12: false }).slice(0, 17) + " ICT";

function to5m(k1) {
  const out = []; let cur = null;
  for (const [t, , h, l, c, qv] of k1) {
    const b = t - (t % 300000);
    if (!cur || cur[0] !== b) { if (cur) out.push(cur); cur = [b, h, l, c, qv, 1]; }
    else { cur[1] = Math.max(cur[1], h); cur[2] = Math.min(cur[2], l); cur[3] = c; cur[4] += qv; cur[5]++; }
  }
  if (cur && cur[5] === 5) out.push(cur);
  return out.filter((x) => x[5] === 5);
}

const files = readdirSync(K1).filter((f) => f.endsWith(".json") && existsSync(`${OI}/${f}`));
let endMs = arg("end") ? Date.parse(arg("end")) : null;
const series = [];
for (const f of files) {
  const s = f.slice(0, -5); if (ONLY && !ONLY.has(s)) continue;
  const p5 = to5m(JSON.parse(readFileSync(`${K1}/${f}`, "utf8")));
  const oiMap = new Map(JSON.parse(readFileSync(`${OI}/${f}`, "utf8")).map((x) => [x[0], x[1]]));
  if (p5.length < 400) continue;
  series.push({ s, p5, oiMap });
}
if (!endMs) endMs = Math.min(...series.map((x) => x.p5[x.p5.length - 1][0]));
const fromMs = endMs - HOURS * 3600e3;

const cands = []; const base = { long: [0, 0], short: [0, 0] };
for (const { s, p5, oiMap } of series) {
  for (let t = 300; t < p5.length; t++) {
    const ts = p5[t][0]; if (ts < fromMs || ts > endMs) continue;
    // baseline every 30 min
    if (ts % 1800000 === 0) {
      for (const side of ["long", "short"]) { const g = gradePath5(p5, t, side, 3, 2, 96); if (g.result === "win") base[side][0]++; if (g.result === "win" || g.result === "loss") base[side][1]++; }
    }
    const W = TH.windowBars;
    const price = []; const oi = []; let ok = true;
    for (let i = t - W; i <= t; i++) { const v = oiMap.get(p5[i][0]); if (!(v > 0)) { ok = false; break; } price.push([p5[i][0], p5[i][1], p5[i][2], p5[i][3]]); oi.push([p5[i][0], v]); }
    if (!ok) continue;
    let hi = -Infinity, lo = Infinity, vol = 0;
    for (let i = t - 287; i <= t; i++) { hi = Math.max(hi, p5[i][1]); lo = Math.min(lo, p5[i][2]); vol += p5[i][4]; }
    const pct24h = (p5[t][3] / p5[t - 288][3] - 1) * 100;
    const sig = evaluateWatch(price, oi, { high24: hi, low24: lo, pct24h, vol24hUsd: vol }, TH);
    if (!sig) continue;
    const g = gradePath5(p5, t, sig.side, 3, 2, 96);
    // did it pump/dump >= 5% at any point within 12h (context)
    let big = 0; for (let i = t + 1; i <= Math.min(p5.length - 1, t + 144); i++) big = Math.max(big, sig.side === "long" ? (p5[i][1] / p5[t][3] - 1) * 100 : (1 - p5[i][2] / p5[t][3]) * 100);
    cands.push({ s, ts: ts + 300000, sig, g, big12h: big });
  }
}
cands.sort((a, b) => a.ts - b.ts);
const sent = {}; const alerts = []; const perCycle = new Map();
for (const c of cands) {
  const k = `${c.s}|${c.sig.tier}`;
  if (sent[k] && c.ts - sent[k] < DEDUPE_MS) continue;
  const n = perCycle.get(c.ts) || 0; if (n >= 2) continue;
  sent[k] = c.ts; perCycle.set(c.ts, n + 1); alerts.push(c);
}
console.log(`window ${fmt(fromMs)} → ${fmt(endMs)} symbols=${series.length} th=${JSON.stringify(TH)}`);
for (const tier of ["accumulation", "distribution"]) {
  const a = alerts.filter((x) => x.sig.tier === tier);
  const w = a.filter((x) => x.g.result === "win").length, l = a.filter((x) => x.g.result === "loss").length;
  const big = a.filter((x) => x.big12h >= 5).length;
  console.log(`${tier}: alerts=${a.length} win=${w} loss=${l} other=${a.length - w - l} hit=${w + l ? ((w / (w + l)) * 100).toFixed(1) : "n/a"}% | moved>=5% same-dir within 12h: ${big}/${a.length}`);
}
console.log(`baseline (every 30m bar): long hit=${(base.long[0] / base.long[1] * 100).toFixed(1)}% (${base.long[1]}) short hit=${(base.short[0] / base.short[1] * 100).toFixed(1)}% (${base.short[1]})`);
if (VERBOSE || alerts.length <= 40) for (const c of alerts) console.log(`${fmt(c.ts)} ${c.s.padEnd(14)} ${c.sig.tier.padEnd(12)} px=${c.sig.close} range${c.sig.windowHours}h=${c.sig.rangePct}% OI+${c.sig.oiChangePct}% 24h=${c.sig.pct24h.toFixed(1)}%${c.sig.pumpPct ? " pump=" + c.sig.pumpPct + "% belowHigh=" + c.sig.belowHighPct + "%" : ""} → ${c.g.result} mfe=${c.g.mfe.toFixed(1)}% big12h=${c.big12h.toFixed(1)}%`);
