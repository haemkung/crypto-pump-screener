#!/usr/bin/env node
/**
 * Backtest the CONFLUENCE-first early tiers vs the price-only baseline.
 *
 *   node scripts/backtest-early-confluence.mjs --data <dir> --windows "k:2026-09-25T02:25:00+07:00,k2:2026-09-23T21:25:00+07:00"
 *
 * <dir> layout (one JSON per symbol, built from Binance public endpoints):
 *   <kdir>/SYM.json   1m klines  [[openTime,o,h,l,c,quoteVol],...]
 *   oi/SYM.json       openInterestHist 5m [[ts,sumOI,sumOIValue]]
 *   ls/SYM.json       globalLongShortAccountRatio 5m [[ts,ratio]]
 *   taker/SYM.json    takerlongshortRatio 5m [[ts,buyVol,sellVol]]
 *   spot/SYM.json     spot 5m klines [[openTime,close,quoteVol,takerBuyQuoteVol]] ([] if no spot pair)
 *   fund/SYM.json     fundingRate history [[fundingTime, ratePct]]
 * Each window = 24h ending at the given time. Outcomes:
 *   big   = +8% before -2% within 12h (short: -8% before +2%)
 *   small = +3% before -2% within 4h
 * Heuristic only — not financial advice.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TRIGGER_THRESHOLDS, CONFLUENCE_RULES, DEFAULT_THRESHOLDS, evaluateIgnition, gradePath, dedupeAllows, barsNeeded, relMove, MIN_REL_MOVE, evaluateEvidence } from "./lib/early-ignition-core.mjs";
const __self = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const DATA = arg("data", "."); process.chdir(DATA);
const windows = arg("windows", "k:2026-09-25T02:25:00+07:00").split(",").map((w) => { const i = w.indexOf(":"); return [w.slice(0, i), w.slice(i + 1)]; });
const LOOSE = { ...TRIGGER_THRESHOLDS };
const rd = (p) => existsSync(p) ? JSON.parse(readFileSync(p)) : null;
function to5m(k1) { const out = []; let cur = null; for (const [t, , h, l, c, qv] of k1) { const b = t - (t % 300000); if (!cur || cur[0] !== b) { if (cur) out.push(cur); cur = [b, h, l, c, qv, 1]; } else { cur[1] = Math.max(cur[1], h); cur[2] = Math.min(cur[2], l); cur[3] = c; cur[4] += qv; cur[5]++; } } if (cur) out.push(cur); return out.filter(x => x[5] === 5).map(x => [x[0] + 300000 - 1, x[1], x[2], x[3], x[4]]); } // ts = bar close
// big-move grade on 1m bars
function gradeBig(bars, t, side, win = 8, loss = 2, hz = 720) { const g = gradePath(bars, t, side, win, loss, hz); return g.result; }
const onlySyms = process.env.SYMS ? new Set(process.env.SYMS.split(",")) : null;
const trig = [], setups = [], base = [];
const SETUP = process.env.NOSETUP ? false : true;
for (const [wi, [dir, end]] of windows.entries()) {
  const E = Date.parse(end), F = E - 24 * 3600e3;
  const btc = rd(`${dir}/BTCUSDT.json`); const bIdx = new Map(btc.map((b, i) => [b[0], i]));
  for (const f of readdirSync(dir)) {
    const s = f.slice(0, -5); if (onlySyms && !onlySyms.has(s)) continue;
    const k1 = rd(`${dir}/${f}`); if (!k1 || k1.length < 2000) continue;
    const oiRaw = rd(`oi/${f}`), lsRaw = rd(`ls/${f}`), tkRaw = rd(`taker/${f}`), sp = rd(`spot/${f}`), fund = rd(`fund/${f}`) || [];
    if (!oiRaw || !lsRaw || !tkRaw) continue;
    // OI/LS/taker timestamps: treat point ts as bucket start -> available at ts+5m
    const oi5 = oiRaw.map(x => [x[0] + 300000 - 1, x[1]]), ls5 = lsRaw.map(x => [x[0] + 300000 - 1, x[1]]), tk5 = tkRaw.map(x => [x[0] + 300000 - 1, x[1], x[2]]);
    const spot5 = sp && sp.length ? sp.map(x => [x[0] + 300000 - 1, x[1], x[2], x[3]]) : null;
    const p5 = to5m(k1);
    const fundAt = (ts) => { let v = null; for (const x of fund) { if (x[0] <= ts) v = x[1]; else break; } return v; };
    const dayAt = (ts) => { let hi = -Infinity, lo = Infinity; for (let i = p5.length - 1; i >= 0; i--) { if (p5[i][0] > ts) continue; if (p5[i][0] < ts - 24 * 3600e3) break; hi = Math.max(hi, p5[i][1]); lo = Math.min(lo, p5[i][2]); } return { high24: hi, low24: lo }; };
    const data = { p5, oi5, ls5, tk5, spot5 };
    // --- triggers (1m)
    for (let t = barsNeeded(LOOSE); t < k1.length - 1; t++) {
      const ts = k1[t][0]; if (ts < F || ts > E) continue;
      if (ts % 1800000 === 0) { for (const side of ["long", "short"]) base.push({ wi, side, big: gradeBig(k1, t, side), small: gradePath(k1, t, side, 3, 2, 240).result }); }
      const ref = k1[Math.max(0, t - 1440)][1]; const pct24h = (k1[t][4] / ref - 1) * 100;
      let v = 0; for (let i = Math.max(0, t - 1439); i <= t; i++) v += k1[i][5];
      const sig = evaluateIgnition(k1, t, { pct24h, vol24hUsd: v }, LOOSE); if (!sig) continue;
      const bi = bIdx.get(ts); let bm = NaN; if (bi != null && bi >= sig.moveWindow && s !== "BTCUSDT") bm = (btc[bi][4] / btc[bi - sig.moveWindow][4] - 1) * 100;
      const rel = relMove(sig, bm);
      const asOf = k1[t - sig.moveWindow][0] + 59999; // close of the bar before the move window
      const ev = evaluateEvidence(sig.side, { ...data, fundingPct: fundAt(asOf), day: dayAt(asOf) }, asOf);
      // price-only (production-price rule) flag
      const strict = evaluateIgnition(k1, t, { pct24h, vol24hUsd: v }, DEFAULT_THRESHOLDS);
      const priceOnly = !!(strict && strict.side === sig.side && (s === "BTCUSDT" || rel >= MIN_REL_MOVE[sig.side]));
      trig.push({ wi, s, ts: ts + 60000, side: sig.side, mv: Math.abs(sig.movePct), vm: sig.volMult, base: sig.baseRangePct, p24: pct24h, rel, priceOnly, n: ev.count, d: ev.directional, keys: ev.factors.map(x => x.key), big: gradeBig(k1, t, sig.side), small: gradePath(k1, t, sig.side, 3, 2, 240).result, price: sig.close });
    }
    // --- setups (5m, no price trigger)
    if (SETUP) for (let i = 300; i < p5.length; i++) {
      const ts = p5[i][0]; if (ts < F || ts > E) continue;
      for (const side of ["long", "short"]) {
        const ev = evaluateEvidence(side, { ...data, fundingPct: fundAt(ts), day: dayAt(ts) }, ts);
        if (ev.count < 2 || !ev.factors.some(x => x.key === "oiBuild")) continue;
        const t1 = k1.findIndex(b => b[0] > ts); if (t1 < 0) continue;
        setups.push({ wi, s, ts, side, n: ev.count, d: ev.directional, keys: ev.factors.map(x => x.key), big: gradeBig(k1, t1 - 1, side), small: gradePath(k1, t1 - 1, side, 3, 2, 240).result });
      }
    }
  }
}
if (arg("out")) writeFileSync(arg("out"), JSON.stringify({ trig, setups, base }));
report({ trig, setups, base }, CONFLUENCE_RULES, windows.length);

export function summarize(rows, nWin) {
  const per = Array.from({ length: nWin }, () => 0);
  for (const r of rows) per[r.wi]++;
  const dec = (k) => rows.filter((r) => r[k] === "win" || r[k] === "loss");
  const w = (k) => dec(k).filter((r) => r[k] === "win").length;
  const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + "%" : "n/a");
  return `n=${rows.length} perDay=[${per.join(",")}] big(+8/-2,12h)=${w("big")}/${dec("big").length} ${pct(w("big"), dec("big").length)} (of all ${pct(w("big"), rows.length)}) | small(+3/-2,4h)=${w("small")}/${dec("small").length} ${pct(w("small"), dec("small").length)}`;
}
function dedupe(rows, ms) {
  const last = {}; const out = [];
  for (const r of rows.sort((a, b) => a.ts - b.ts)) { const k = `${r.wi}|${r.s}|${r.side}`; if (last[k] && r.ts - last[k] < ms) continue; last[k] = r.ts; out.push(r); }
  return out;
}
function report(d, rules, nWin) {
  console.log(`windows: ${windows.map((w) => w[1]).join(" | ")} (24h each)`);
  for (const side of ["long", "short"]) {
    console.log(`== ${side.toUpperCase()}`);
    console.log("  random entry (every 30m)      ", summarize(d.base.filter((r) => r.side === side).map((r) => ({ ...r, s: "", ts: 0 })), nWin));
    console.log("  price-only ignition (old rule)", summarize(dedupe(d.trig.filter((r) => r.side === side && r.priceOnly), 2 * 3600e3), nWin));
    console.log("  price trigger, no evidence req", summarize(dedupe(d.trig.filter((r) => r.side === side), 2 * 3600e3), nWin));
    console.log(`  CONFLUENCE ignition (>=${rules.ignitionMinFactors}f, >=${rules.ignitionMinDirectional}dir)`, summarize(dedupe(d.trig.filter((r) => r.side === side && r.n >= rules.ignitionMinFactors && r.d >= rules.ignitionMinDirectional), 2 * 3600e3), nWin));
    console.log(`  WATCH setup (OI build + >=${rules.watchMinFactors}f, >=${rules.watchMinDirectional}dir)`, summarize(dedupe(d.setups.filter((r) => r.side === side && r.n >= rules.watchMinFactors && r.d >= rules.watchMinDirectional), 4 * 3600e3), nWin));
  }
}
