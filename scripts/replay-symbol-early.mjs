#!/usr/bin/env node
/**
 * Replay one symbol through the FINAL early-tier rules (data/early-tier-config.json) on cached data.
 *   node scripts/replay-symbol-early.mjs --data /workspace/cache/early-bt-30d --symbol QNTUSDT --from 2026-09-24T00:00:00+07:00 --to 2026-09-25T04:00:00+07:00
 * Prints: pre-move base, peak, first time each tier would fire (ICT) and % from base, or why not.
 */
import { readFileSync, existsSync } from "node:fs";
import { TRIGGER_THRESHOLDS, evaluateIgnition, barsNeeded, relMove, MIN_REL_MOVE, evaluateEvidence, structuralStop } from "./lib/early-ignition-core.mjs";
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const DIR = arg("data", "/workspace/cache/early-bt-30d"), S = arg("symbol", "QNTUSDT");
const FROM = Date.parse(arg("from", "2026-09-24T00:00:00+07:00")), TO = Date.parse(arg("to", "2026-09-25T04:00:00+07:00"));
const cfg = JSON.parse(readFileSync("data/early-tier-config.json", "utf8")).tiers;
const rd = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
const k1 = rd(`${DIR}/k/${S}.json`), btc = rd(`${DIR}/k/BTCUSDT.json`);
const ff = (raw, map) => { const out = []; for (const x of raw || []) { const k = x[0] + 900000 - 1; const v = map(x); for (let j = 0; j < 3; j++) out.push([k + j * 300000, ...v]); } return out; };
const oi5 = ff(rd(`${DIR}/oi/${S}.json`), (x) => [x[1]]), ls5 = ff(rd(`${DIR}/ls/${S}.json`), (x) => [x[1]]), top5 = ff(rd(`${DIR}/top/${S}.json`), (x) => [x[1]]), tk5 = ff(rd(`${DIR}/taker/${S}.json`), (x) => [x[1] / 3, x[2] / 3]);
const sp = rd(`${DIR}/spot/${S}.json`); const spot5 = sp && sp.length > 300 ? sp.map((x) => [x[0] + 299999, x[1], x[2], x[3]]) : null;
const fund = rd(`${DIR}/fund/${S}.json`) || [];
const p5 = []; let cur = null;
for (const [t, , h, l, c, qv] of k1) { const b = t - (t % 300000); if (!cur || cur[0] !== b) { if (cur && cur[5] === 5) p5.push([cur[0] + 299999, cur[1], cur[2], cur[3], cur[4]]); cur = [b, h, l, c, qv, 1]; } else { cur[1] = Math.max(cur[1], h); cur[2] = Math.min(cur[2], l); cur[3] = c; cur[4] += qv; cur[5]++; } }
const idxAt = (arr, ts) => { let lo = 0, hi = arr.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m][0] <= ts) { a = m; lo = m + 1; } else hi = m - 1; } return a; };
const dayAt = (ts) => { const i = idxAt(p5, ts); let h = -Infinity, l = Infinity; for (let j = Math.max(0, i - 287); j <= i; j++) { h = Math.max(h, p5[j][1]); l = Math.min(l, p5[j][2]); } return { high24: h, low24: l }; };
const ev = (side, ts) => { const fi = idxAt(fund, ts); return evaluateEvidence(side, { p5, oi5, ls5, top5, tk5, spot5, fundingPct: fi >= 0 ? fund[fi][1] : null, day: dayAt(ts) }, ts); };
const ict = (ms) => new Date(ms + 7 * 3600e3).toISOString().slice(5, 16).replace("T", " ") + " ICT";
const win = k1.filter((b) => b[0] >= FROM && b[0] <= TO);
let lo = Infinity, loT = 0, hi = -Infinity, hiT = 0;
for (const b of win) { if (b[3] < lo) { lo = b[3]; loT = b[0]; } }
for (const b of win) if (b[0] >= loT && b[2] > hi) { hi = b[2]; hiT = b[0]; }
// base = median close of the 6h before the low→high leg starts accelerating (use 6h before first +3% from low)
const legStart = win.find((b) => b[0] >= loT && b[4] >= lo * 1.03)?.[0] ?? loT;
const baseBars = k1.filter((b) => b[0] < legStart && b[0] >= legStart - 6 * 3600e3).map((b) => b[4]).sort((a, b) => a - b);
const base = baseBars[Math.floor(baseBars.length / 2)];
console.log(`${S}: window low ${lo} @${ict(loT)} → high ${hi} @${ict(hiT)} (+${((hi / lo - 1) * 100).toFixed(1)}%); pre-move base (6h median before leg) ${base?.toPrecision(5)} ; leg starts ${ict(legStart)}`);
const need = barsNeeded(TRIGGER_THRESHOLDS); const bIdx = new Map(btc.map((b, i) => [b[0], i]));
const first = {}; const best = { ignition_long: null, ignition_short: null, watch_long: null, watch_short: null };
const note = (k, n, keys, ts, why) => { if (!best[k] || n > best[k].n) best[k] = { n, keys, ts, why }; };
let trigCount = { long: 0, short: 0 };
for (let t = need; t < k1.length - 1; t++) {
  if (k1[t][0] < FROM || k1[t][0] > TO) continue;
  let vol = 0; for (let i = Math.max(0, t - 1439); i <= t; i++) vol += k1[i][5];
  const pct24h = (k1[t][4] / k1[Math.max(0, t - 1440)][1] - 1) * 100;
  const sig = evaluateIgnition(k1, t, { pct24h, vol24hUsd: vol }, TRIGGER_THRESHOLDS);
  if (sig) {
    trigCount[sig.side]++;
    const key = `ignition_${sig.side}`, p = cfg[key].params;
    const bi = bIdx.get(k1[t][0]); const bm = bi != null ? (btc[bi][4] / btc[bi - sig.moveWindow][4] - 1) * 100 : NaN;
    const relOk = relMove(sig, bm) >= MIN_REL_MOVE[sig.side];
    const e = ev(sig.side, k1[t - sig.moveWindow][0] + 59999);
    const st = structuralStop(sig.side, k1[t][4], { mode: p.slMode, bars: k1, t, level: sig.side === "long" ? sig.rangeHigh : sig.rangeLow });
    const pass = e.count >= p.minFactors && e.directional >= p.minDirectional && (!p.requireRelMove || relOk);
    if (pass && !first[key]) first[key] = { ts: k1[t][0] + 60000, px: k1[t][4], n: e.count, keys: e.factors.map((f) => f.key), sl: st.slPct, skip: st.skip };
    if (!pass) note(key, e.count, e.factors.map((f) => f.key), k1[t][0] + 60000, `${e.count}f/${e.directional}dir relOk=${relOk}`);
  }
}
for (const x of p5) {
  if (x[0] < FROM || x[0] > TO) continue;
  for (const side of ["long", "short"]) {
    const key = `watch_${side}`, p = cfg[key].params, e = ev(side, x[0]);
    const pass = e.count >= p.minFactors && e.directional >= p.minDirectional && e.factors.some((f) => f.key === "oiBuild");
    if (pass && !first[key]) first[key] = { ts: x[0] + 1, px: x[3], n: e.count, keys: e.factors.map((f) => f.key) };
    if (!pass) note(key, e.count, e.factors.map((f) => f.key), x[0] + 1, `${e.count}f/${e.directional}dir oiBuild=${e.factors.some((f) => f.key === "oiBuild")}`);
  }
}
console.log(`price triggers in window: long ${trigCount.long}, short ${trigCount.short}`);
for (const k of Object.keys(best)) {
  const f = first[k];
  if (f) console.log(`${k}: FIRES ${ict(f.ts)} @${f.px} = ${base ? ((f.px / base - 1) * 100).toFixed(1) : "?"}% from base · ${f.n} factors [${f.keys}]${f.sl != null ? ` · SL ${f.sl}%${f.skip ? " (SL กว้างเกิน → web only)" : ""}` : ""}`);
  else console.log(`${k}: does NOT fire · best evidence ${best[k] ? `${best[k].n} factors [${best[k].keys}] @${ict(best[k].ts)} (${best[k].why})` : "no candidate"} · params ${JSON.stringify(cfg[k].params)}`);
}
