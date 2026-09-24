#!/usr/bin/env node
/**
 * Download public Binance data for scripts/backtest-early-confluence.mjs (resumable, rate-limited).
 *
 *   node scripts/fetch-early-backtest-data.mjs --out /tmp/early-bt --kdir k --hours 55 [--symbols A,B] [--only k,oi,ls,taker,spot,fund]
 *
 * /futures/data endpoints are limited to ~1000 req / 5 min per IP (shared with the Next app + daemon),
 * so those are paced at ~2 req/s. 5m futures/data history is only available for the last 30 days.
 */
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const OUT = arg("out", "/tmp/early-bt");
const KDIR = arg("kdir", "k");
const HOURS = Number(arg("hours", "55"));
const END = arg("end") ? Date.parse(arg("end")) : Date.now();
const ONLY = new Set(arg("only", "k,oi,ls,taker,spot,fund").split(","));
const H = "https://www.binance.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function j(path) {
  for (let a = 0; a < 6; a++) {
    let r;
    try { r = await fetch(H + path, { signal: AbortSignal.timeout(15000) }); } catch { await sleep(3000); continue; }
    if (r.status === 429 || r.status === 418) { console.log("rate limited, backing off"); await sleep(90000); continue; }
    if (r.status === 400) return null;
    if (!r.ok) throw new Error(`${r.status} ${path}`);
    const w = Number(r.headers.get("x-mbx-used-weight-1m"));
    if (!path.startsWith("/futures/data") && w > 1800) await sleep(15000);
    return r.json();
  }
  return null;
}
let syms = arg("symbols")?.split(",");
if (!syms) {
  const info = await j("/fapi/v1/exchangeInfo");
  syms = info.symbols.filter((s) => s.contractType === "PERPETUAL" && s.quoteAsset === "USDT" && s.status === "TRADING").map((s) => s.symbol);
}
for (const d of [KDIR, "oi", "ls", "taker", "spot", "fund"]) mkdirSync(`${OUT}/${d}`, { recursive: true });
const pages = Math.ceil((HOURS * 12) / 500);
async function hist(ep, s, map) {
  let all = [], endTime = END;
  for (let p = 0; p < pages; p++) {
    const a = (await j(`/futures/data/${ep}?symbol=${s}&period=5m&limit=500&endTime=${endTime}`)) || [];
    if (!a.length) break;
    all = [...a, ...all];
    endTime = a[0].timestamp - 1;
    await sleep(450);
  }
  return all.map(map);
}
let i = 0;
for (const s of syms) {
  i++;
  try {
    if (ONLY.has("k") && !existsSync(`${OUT}/${KDIR}/${s}.json`)) {
      let all = [], st = END - HOURS * 3600e3;
      while (st < END) {
        const b = await j(`/fapi/v1/klines?symbol=${s}&interval=1m&startTime=${st}&limit=1500`);
        if (!b || !b.length) break;
        all = all.concat(b.map((x) => [x[0], +x[1], +x[2], +x[3], +x[4], +x[7]]));
        st = b[b.length - 1][0] + 60000;
        if (b.length < 1500) break;
        await sleep(150);
      }
      writeFileSync(`${OUT}/${KDIR}/${s}.json`, JSON.stringify(all));
    }
    if (ONLY.has("oi") && !existsSync(`${OUT}/oi/${s}.json`)) writeFileSync(`${OUT}/oi/${s}.json`, JSON.stringify(await hist("openInterestHist", s, (x) => [x.timestamp, +x.sumOpenInterest, +x.sumOpenInterestValue])));
    if (ONLY.has("ls") && !existsSync(`${OUT}/ls/${s}.json`)) writeFileSync(`${OUT}/ls/${s}.json`, JSON.stringify(await hist("globalLongShortAccountRatio", s, (x) => [x.timestamp, +x.longShortRatio])));
    if (ONLY.has("taker") && !existsSync(`${OUT}/taker/${s}.json`)) writeFileSync(`${OUT}/taker/${s}.json`, JSON.stringify(await hist("takerlongshortRatio", s, (x) => [x.timestamp, +x.buyVol, +x.sellVol])));
    if (ONLY.has("spot") && !existsSync(`${OUT}/spot/${s}.json`)) {
      const a = await j(`/api/v3/klines?symbol=${s.replace(/^1000+/, "")}&interval=5m&limit=1000&endTime=${END}`);
      writeFileSync(`${OUT}/spot/${s}.json`, JSON.stringify(a ? a.map((x) => [x[0], +x[4], +x[7], +x[10]]) : []));
    }
    if (ONLY.has("fund") && !existsSync(`${OUT}/fund/${s}.json`)) {
      const a = (await j(`/fapi/v1/fundingRate?symbol=${s}&limit=40&endTime=${END}`)) || [];
      writeFileSync(`${OUT}/fund/${s}.json`, JSON.stringify(a.map((x) => [x.fundingTime, +x.fundingRate * 100])));
      await sleep(600);
    }
  } catch (e) { console.log("err", s, String(e)); }
  if (i % 25 === 0) console.log("done", i, "/", syms.length);
}
console.log("finished");
