#!/usr/bin/env node
/**
 * 30-day Binance public-data cache for walk-forward validation of the early tiers.
 *
 *   node scripts/fetch-early-backtest-30d.mjs --out /workspace/cache/early-bt-30d [--days 29.5] [--top 250] [--moverPct 15]
 *
 * Universe: top-N USDT-M perps by 24h quote volume  ∪  every perp that had a >= moverPct daily range in the window.
 * Layout (same as scripts/backtest-early-confluence.mjs expects, 1m klines in k/):
 *   k/SYM.json [[openTime,o,h,l,c,quoteVol]] 1m · oi/ ls/ top/ taker/ (futures/data, 15m buckets) · spot/ 5m · fund/
 * Two lanes run concurrently: /fapi + /api (weight-header paced) and /futures/data (~2.2 req/s, 1000 req/5min IP cap).
 * Resumable (skips files that exist). Public endpoints only, no keys.
 */
import { writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const OUT = arg("out", "/workspace/cache/early-bt-30d");
const DAYS = Number(arg("days", "29.5"));
const TOP = Number(arg("top", "250"));
const MOVER = Number(arg("moverPct", "15"));
const PERIOD = arg("period", "15m");
import { readFileSync as _rf } from "node:fs";
const _u = (() => { try { return JSON.parse(_rf(`${OUT}/universe.json`, "utf8")); } catch { return null; } })();
const END = arg("end") ? Date.parse(arg("end")) : _u?.end ?? Date.now() - 120000;
const START = _u?.start ?? END - DAYS * 86400e3;
const H = "https://www.binance.com";
const LANES = new Set(arg("lanes", "fapi,data").split(","));
const [SHARD, NSHARD] = (arg("shard", "0/1")).split("/").map(Number);
const DATA_SLEEP = Number(arg("dataSleep", "430"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fapiWeight = 0;
async function j(path, lane) {
  for (let a = 0; a < 8; a++) {
    let r;
    try { r = await fetch(H + path, { signal: AbortSignal.timeout(20000) }); } catch { await sleep(3000 * (a + 1)); continue; }
    if (r.status === 429 || r.status === 418) { console.log(lane, "rate limited", r.status, "backing off"); await sleep(r.status === 418 ? 300000 : 90000); continue; }
    if (r.status === 400) return null;
    if (!r.ok) { await sleep(5000); continue; }
    let body;
    try { body = JSON.parse(await r.text()); } catch { await sleep(3000); continue; }
    const w = Number(r.headers.get("x-mbx-used-weight-1m"));
    if (Number.isFinite(w)) fapiWeight = w;
    if (lane === "fapi" && w > 1300) await sleep(20000);
    return body;
  }
  return null;
}
function save(p, v) { writeFileSync(p + ".tmp", JSON.stringify(v)); renameSync(p + ".tmp", p); }
for (const d of ["k", "oi", "ls", "top", "taker", "spot", "fund"]) mkdirSync(`${OUT}/${d}`, { recursive: true });

// ---- universe (reused from universe.json when present so shards agree)
let syms;
if (existsSync(`${OUT}/universe.json`)) syms = JSON.parse(_rf(`${OUT}/universe.json`, "utf8")).syms;
else {
const info = await j("/fapi/v1/exchangeInfo", "fapi");
const perps = info.symbols.filter((s) => s.contractType === "PERPETUAL" && s.quoteAsset === "USDT" && s.status === "TRADING").map((s) => s.symbol);
const tick = await j("/fapi/v1/ticker/24hr", "fapi");
const vol = new Map(tick.map((t) => [t.symbol, +t.quoteVolume]));
const byVol = perps.filter((s) => vol.has(s)).sort((a, b) => vol.get(b) - vol.get(a));
const universe = new Set(byVol.slice(0, TOP));
universe.add("BTCUSDT");
let movers = 0;
for (const s of byVol.slice(TOP)) {
  const d = await j(`/fapi/v1/klines?symbol=${s}&interval=1d&startTime=${START}&limit=40`, "fapi");
  if (d && d.some((x) => (+x[2] / +x[3] - 1) * 100 >= MOVER) && (vol.get(s) || 0) >= 3e6) { universe.add(s); movers++; }
  await sleep(60);
}
syms = [...universe];
save(`${OUT}/universe.json`, { end: END, start: START, days: DAYS, top: TOP, movers, syms });
console.log("universe", syms.length, "top", TOP, "extra movers", movers);
}
syms = syms.filter((_, i) => i % NSHARD === SHARD);

async function fapiLane() {
  let i = 0;
  for (const s of syms) {
    i++;
    try {
      if (!existsSync(`${OUT}/k/${s}.json`)) {
        const all = []; let st = START;
        while (st < END) {
          const b = await j(`/fapi/v1/klines?symbol=${s}&interval=1m&startTime=${st}&endTime=${END}&limit=1000`, "fapi");
          if (!b || !b.length) break;
          for (const x of b) all.push([x[0], +x[1], +x[2], +x[3], +x[4], Math.round(+x[7])]);
          st = b[b.length - 1][0] + 60000;
          if (b.length < 1000) break;
          await sleep(110);
        }
        save(`${OUT}/k/${s}.json`, all);
      }
      if (!existsSync(`${OUT}/spot/${s}.json`)) {
        const sp = s.replace(/^1000+/, ""); const all = []; let st = START;
        while (st < END) {
          const a = await j(`/api/v3/klines?symbol=${sp}&interval=5m&startTime=${st}&endTime=${END}&limit=1000`, "fapi");
          if (!a || !a.length) break;
          for (const x of a) all.push([x[0], +x[4], Math.round(+x[7]), Math.round(+x[10])]);
          st = a[a.length - 1][0] + 300000;
          if (a.length < 1000) break;
          await sleep(100);
        }
        save(`${OUT}/spot/${s}.json`, all);
      }
      if (!existsSync(`${OUT}/fund/${s}.json`)) {
        const a = (await j(`/fapi/v1/fundingRate?symbol=${s}&startTime=${START - 86400e3}&endTime=${END}&limit=1000`, "fapi")) || [];
        save(`${OUT}/fund/${s}.json`, a.map((x) => [x.fundingTime, +x.fundingRate * 100]));
        await sleep(300);
      }
    } catch (e) { console.log("fapi err", s, String(e).slice(0, 100)); }
    if (i % 25 === 0) console.log("fapi lane", i, "/", syms.length, "weight", fapiWeight);
  }
  console.log("fapi lane finished");
}
const pms = { "5m": 300000, "15m": 900000, "1h": 3600000 }[PERIOD];
async function hist(ep, s, map) {
  const out = new Map(); let endTime = END;
  for (let p = 0; p < 40; p++) {
    const a = await j(`/futures/data/${ep}?symbol=${s}&period=${PERIOD}&limit=500&endTime=${endTime}`, "data");
    await sleep(DATA_SLEEP);
    if (!a || !a.length) break;
    for (const x of a) out.set(x.timestamp, map(x));
    endTime = a[0].timestamp - 1;
    if (a[0].timestamp <= START || a.length < 500) break;
  }
  return [...out.values()].sort((x, y) => x[0] - y[0]);
}
async function dataLane() {
  let i = 0;
  for (const s of syms) {
    i++;
    try {
      if (!existsSync(`${OUT}/oi/${s}.json`)) save(`${OUT}/oi/${s}.json`, await hist("openInterestHist", s, (x) => [x.timestamp, +x.sumOpenInterest, Math.round(+x.sumOpenInterestValue)]));
      if (!existsSync(`${OUT}/ls/${s}.json`)) save(`${OUT}/ls/${s}.json`, await hist("globalLongShortAccountRatio", s, (x) => [x.timestamp, +x.longShortRatio]));
      if (!existsSync(`${OUT}/top/${s}.json`)) save(`${OUT}/top/${s}.json`, await hist("topLongShortPositionRatio", s, (x) => [x.timestamp, +x.longShortRatio]));
      if (!existsSync(`${OUT}/taker/${s}.json`)) save(`${OUT}/taker/${s}.json`, await hist("takerlongshortRatio", s, (x) => [x.timestamp, +x.buyVol, +x.sellVol]));
    } catch (e) { console.log("data err", s, String(e).slice(0, 100)); }
    if (i % 10 === 0) console.log("data lane", i, "/", syms.length);
  }
  console.log("data lane finished");
}
await Promise.all([LANES.has("fapi") ? fapiLane() : null, LANES.has("data") ? dataLane() : null]);
console.log("finished");
