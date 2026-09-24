#!/usr/bin/env node
/**
 * Walk-forward validation of the confluence-first early tiers under the tight-stop risk model.
 *
 *   node scripts/walkforward-early.mjs --data /workspace/cache/early-bt-30d [--trainDays 20] [--workers 6] [--out data/early-backtest-oos.json]
 *   node scripts/walkforward-early.mjs --data ... --analyze-only      (reuse <data>/events.json)
 *
 * Phase 1 (worker threads, one symbol at a time): replay every closed 1m bar with the loose price
 *   TRIGGER, evaluate evidence measured BEFORE the move (15m futures/data forward-filled with no look-ahead),
 *   build the stated structural stop (RISK in lib/early-ignition-core.mjs), simulate the trade from the next
 *   bar's OPEN incl. 0.1% round-trip cost. Watch setups every 5m; random entries every 30m; old price-only rule.
 * Phase 2: coarse grid tuned on the first `trainDays`, frozen, then scored on the rest (out-of-sample).
 * Heuristic research tool — not financial advice.
 */
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  TRIGGER_THRESHOLDS, DEFAULT_THRESHOLDS, evaluateIgnition, barsNeeded, relMove, MIN_REL_MOVE,
  evaluateEvidence, structuralStop, simulateTrade, RISK, wilson,
} from "./lib/early-ignition-core.mjs";

const SELF = fileURLToPath(import.meta.url);
const IGN_SL_MODES = ["breakout", "swing5", "swing15"];
const WATCH_SL_MODES = ["swing60", "swing180"];
const RAND_SL_MODE = "swing15";

if (!isMainThread) {
  const { dir, syms } = workerData;
  const rd = (p) => { try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; } catch { return null; } };
  const btc = rd(`${dir}/k/BTCUSDT.json`) || [];
  const bIdx = new Map(btc.map((b, i) => [b[0], i]));
  const pms = 900000;
  const ff = (raw, map) => { const out = []; if (!raw) return out; for (const x of raw) { const k = x[0] + pms - 1; const v = map(x); for (let j = 0; j < 3; j++) out.push([k + j * 300000, ...v]); } return out; };
  const LOOSE = { ...TRIGGER_THRESHOLDS };
  const need = barsNeeded(LOOSE);
  for (const s of syms) {
    const res = { s, trig: [], watch: [], rand: [] };
    try {
      const k1 = rd(`${dir}/k/${s}.json`);
      if (!k1 || k1.length < 3000) { parentPort.postMessage(res); continue; }
      const oi5 = ff(rd(`${dir}/oi/${s}.json`), (x) => [x[1]]);
      const ls5 = ff(rd(`${dir}/ls/${s}.json`), (x) => [x[1]]);
      const top5 = ff(rd(`${dir}/top/${s}.json`), (x) => [x[1]]);
      const tk5 = ff(rd(`${dir}/taker/${s}.json`), (x) => [x[1] / 3, x[2] / 3]);
      const sp = rd(`${dir}/spot/${s}.json`);
      const spot5 = sp && sp.length > 300 ? sp.map((x) => [x[0] + 299999, x[1], x[2], x[3]]) : null;
      const fund = rd(`${dir}/fund/${s}.json`) || [];
      // 5m perp bars (ts = close)
      const p5 = []; let cur = null;
      for (const [t, , h, l, c, qv] of k1) { const b = t - (t % 300000); if (!cur || cur[0] !== b) { if (cur && cur[5] === 5) p5.push([cur[0] + 299999, cur[1], cur[2], cur[3], cur[4]]); cur = [b, h, l, c, qv, 1]; } else { cur[1] = Math.max(cur[1], h); cur[2] = Math.min(cur[2], l); cur[3] = c; cur[4] += qv; cur[5]++; } }
      const hi24 = new Float64Array(p5.length), lo24 = new Float64Array(p5.length);
      for (let i = 0; i < p5.length; i++) { let h = -Infinity, l = Infinity; for (let j = Math.max(0, i - 287); j <= i; j++) { if (p5[j][1] > h) h = p5[j][1]; if (p5[j][2] < l) l = p5[j][2]; } hi24[i] = h; lo24[i] = l; }
      const idxAt = (arr, ts) => { let lo = 0, hi = arr.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m][0] <= ts) { a = m; lo = m + 1; } else hi = m - 1; } return a; };
      const fundAt = (ts) => { const i = idxAt(fund, ts); return i >= 0 ? fund[i][1] : null; };
      const dayAt = (ts) => { const i = idxAt(p5, ts); return i >= 0 ? { high24: hi24[i], low24: lo24[i] } : null; };
      const base = { p5, oi5, ls5, top5, tk5, spot5 };
      const ev = (side, ts) => evaluateEvidence(side, { ...base, fundingPct: fundAt(ts), day: dayAt(ts) }, ts);
      const pre = new Float64Array(k1.length + 1); for (let i = 0; i < k1.length; i++) pre[i + 1] = pre[i] + k1[i][5];
      const minT = k1[0][0] + 24 * 3600e3; // warm-up: need 24h of history for evidence
      const outcomes = (side, t, modes, level) => {
        const e = t + 1; if (e >= k1.length - 30) return null;
        const o = {};
        for (const m of modes) {
          const st = structuralStop(side, k1[e][1], { mode: m, bars: k1, t, level });
          const sim = simulateTrade(k1, e, side, st.slPct);
          o[m] = { sl: st.slPct, st: st.structPct, skip: st.skip, tp1: sim.tp1, tp2: sim.tp2, r: sim.r, big: sim.big, med: sim.medium, done: sim.complete };
        }
        return o;
      };
      // --- triggers + random, per closed 1m bar
      for (let t = need; t < k1.length - 31; t++) {
        const tsOpen = k1[t][0]; if (tsOpen < minT) continue;
        const closeTs = tsOpen + 60000;
        if (closeTs % 1800000 === 0) for (const side of ["long", "short"]) { const o = outcomes(side, t, [RAND_SL_MODE]); if (o) res.rand.push({ ts: closeTs, side, o: o[RAND_SL_MODE] }); }
        const ref = k1[Math.max(0, t - 1440)][1]; const pct24h = (k1[t][4] / ref - 1) * 100;
        const vol24 = pre[t + 1] - pre[Math.max(0, t - 1439)];
        const sig = evaluateIgnition(k1, t, { pct24h, vol24hUsd: vol24 }, LOOSE); if (!sig) continue;
        const bi = bIdx.get(tsOpen); let bm = NaN;
        if (bi != null && bi >= sig.moveWindow && s !== "BTCUSDT") bm = (btc[bi][4] / btc[bi - sig.moveWindow][4] - 1) * 100;
        const rel = relMove(sig, bm);
        const strict = evaluateIgnition(k1, t, { pct24h, vol24hUsd: vol24 }, DEFAULT_THRESHOLDS);
        const priceOnly = !!(strict && strict.side === sig.side && (s === "BTCUSDT" || rel >= MIN_REL_MOVE[sig.side]));
        const asOf = k1[t - sig.moveWindow][0] + 59999;
        const e = ev(sig.side, asOf);
        if (e.count < 3 && !priceOnly) continue;
        const o = outcomes(sig.side, t, IGN_SL_MODES, sig.side === "long" ? sig.rangeHigh : sig.rangeLow); if (!o) continue;
        res.trig.push({ ts: closeTs, side: sig.side, n: e.count, d: e.directional, keys: e.factors.map((f) => f.key), rel: Math.round(rel * 100) / 100, relOk: s === "BTCUSDT" || rel >= MIN_REL_MOVE[sig.side], priceOnly, mv: sig.movePct, vm: sig.volMult, fb: sig.fromBasePct, p24: Math.round(pct24h * 10) / 10, o });
      }
      // --- watch setups (no price trigger) every 5m
      const k1Idx = new Map(k1.map((b, i) => [b[0], i]));
      for (let i = 300; i < p5.length; i++) {
        const ts = p5[i][0]; if (ts - 299999 < minT) continue;
        const t = k1Idx.get(ts - 59999); if (t == null) continue;
        for (const side of ["long", "short"]) {
          const e = ev(side, ts);
          if (e.count < 3 || !e.factors.some((f) => f.key === "oiBuild")) continue;
          const o = outcomes(side, t, WATCH_SL_MODES); if (!o) continue;
          res.watch.push({ ts: ts + 1, side, n: e.count, d: e.directional, keys: e.factors.map((f) => f.key), p24: Math.round((p5[i][3] / p5[Math.max(0, i - 288)][3] - 1) * 1000) / 10, o });
        }
      }
    } catch (err) { res.err = String(err?.stack || err).slice(0, 300); }
    parentPort.postMessage(res);
  }
  parentPort.postMessage({ done: true });
} else {
  const args = process.argv.slice(2);
  const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
  const DIR = arg("data", "/workspace/cache/early-bt-30d");
  const TRAIN_DAYS = Number(arg("trainDays", "20"));
  const OUT = arg("out", "data/early-backtest-oos.json");
  const EVF = `${DIR}/events.json`;
  let events;
  if (args.includes("--analyze-only") && existsSync(EVF)) events = JSON.parse(readFileSync(EVF, "utf8"));
  else {
    const syms = (arg("symbols") || "").split(",").filter(Boolean);
    const all = syms.length ? syms : readdirSync(`${DIR}/k`).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
    const W = Number(arg("workers", "6"));
    const chunks = Array.from({ length: W }, () => []); all.forEach((s, i) => chunks[i % W].push(s));
    events = { trig: [], watch: [], rand: [], syms: 0, errors: [] };
    const t0 = Date.now(); let doneSyms = 0;
    await Promise.all(chunks.filter((c) => c.length).map((c) => new Promise((resolve) => {
      const w = new Worker(SELF, { workerData: { dir: DIR, syms: c } });
      w.on("message", (m) => {
        if (m.done) return resolve();
        doneSyms++; events.syms++;
        if (m.err) events.errors.push(`${m.s}: ${m.err}`);
        for (const k of ["trig", "watch", "rand"]) for (const r of m[k]) { r.s = m.s; events[k].push(r); }
        if (doneSyms % 50 === 0) console.log(`replayed ${doneSyms}/${all.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      });
      w.on("error", (e) => { events.errors.push(String(e)); resolve(); });
      w.on("exit", () => resolve());
    })));
    writeFileSync(EVF, JSON.stringify(events));
    console.log(`replay done: syms=${events.syms} trig=${events.trig.length} watch=${events.watch.length} rand=${events.rand.length} errors=${events.errors.length} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  analyze(events);

  function analyze(ev) {
    let t0 = Infinity, t1 = -Infinity;
    for (const r of ev.rand) { if (r.ts < t0) t0 = r.ts; if (r.ts > t1) t1 = r.ts; }
    const split = t0 + TRAIN_DAYS * 86400e3;
    const days = (a, b) => (b - a) / 86400e3;
    const isTrain = (r) => r.ts < split;
    const dedupe = (rows, ms) => { const last = {}; const out = []; for (const r of [...rows].sort((a, b) => a.ts - b.ts)) { const k = `${r.s}|${r.side}`; if (last[k] && r.ts - last[k] < ms) continue; last[k] = r.ts; out.push(r); } return out; };
    // realistic delivery: a signal is only sent if its stop fits the risk rule; trades complete within data
    const stats = (rows, mode, nDays) => {
      const tr = rows.map((r) => r.o[mode]).filter((o) => o && !o.skip && o.done);
      const n = tr.length; const w = tr.filter((o) => o.tp1).length;
      let maxL = 0, curL = 0; const byTime = rows.filter((r) => r.o[mode] && !r.o[mode].skip && r.o[mode].done).sort((a, b) => a.ts - b.ts);
      for (const r of byTime) { if (r.o[mode].r < 0) { curL++; maxL = Math.max(maxL, curL); } else curL = 0; }
      const exp = n ? tr.reduce((a, o) => a + o.r, 0) / n : 0;
      const [lo, hi] = wilson(w, n);
      return { n, perDay: nDays ? Math.round((n / nDays) * 10) / 10 : null, tp1Rate: n ? Math.round((w / n) * 1000) / 10 : null, tp1Wilson: [Math.round(lo * 1000) / 10, Math.round(hi * 1000) / 10], expR: Math.round(exp * 1000) / 1000, sumR: Math.round(exp * n * 100) / 100, maxConsecLoss: maxL, tp2Rate: n ? Math.round((tr.filter((o) => o.tp2).length / n) * 1000) / 10 : null, bigRate: n ? Math.round((tr.filter((o) => o.big).length / n) * 1000) / 10 : null, medRate: n ? Math.round((tr.filter((o) => o.med).length / n) * 1000) / 10 : null, avgSlPct: n ? Math.round((tr.reduce((a, o) => a + o.sl, 0) / n) * 100) / 100 : null, skippedWideSl: rows.filter((r) => r.o[mode]?.skip).length };
    };
    const trainD = days(t0, split), testD = days(split, t1);
    const report = { generatedAt: new Date().toISOString(), data: { symbols: ev.syms, from: new Date(t0).toISOString(), split: new Date(split).toISOString(), to: new Date(t1).toISOString(), trainDays: Math.round(trainD * 10) / 10, testDays: Math.round(testD * 10) / 10 }, risk: RISK, tiers: {} };
    const MIN_TRAIN_N = 25, MIN_OOS_N = 15;
    for (const side of ["long", "short"]) {
      const randRows = ev.rand.filter((r) => r.side === side).map((r) => ({ ...r, o: { [RAND_SL_MODE]: r.o } }));
      const randTest = stats(randRows.filter((r) => !isTrain(r)), RAND_SL_MODE, testD);
      const randTrain = stats(randRows.filter(isTrain), RAND_SL_MODE, trainD);
      // ---- ignition grid
      const trigSide = ev.trig.filter((r) => r.side === side);
      const grid = [];
      for (const minF of [3, 4]) for (const minD of [1, 2]) for (const relReq of [false, true]) for (const mode of IGN_SL_MODES) {
        const sel = (rows) => dedupe(rows.filter((r) => r.n >= minF && r.d >= minD && (!relReq || r.relOk) && r.o[mode] && !r.o[mode].skip), 2 * 3600e3);
        grid.push({ params: { minFactors: minF, minDirectional: minD, requireRelMove: relReq, slMode: mode }, sel, train: stats(sel(trigSide.filter(isTrain)), mode, trainD) });
      }
      const pick = (g) => g.filter((x) => x.train.n >= MIN_TRAIN_N).sort((a, b) => b.train.expR - a.train.expR || b.train.tp1Rate - a.train.tp1Rate)[0] || [...g].sort((a, b) => b.train.n - a.train.n)[0];
      const best = pick(grid);
      const ignTest = stats(best.sel(trigSide.filter((r) => !isTrain(r))), best.params.slMode, testD);
      const poSel = (rows) => dedupe(rows.filter((r) => r.priceOnly && r.o[best.params.slMode] && !r.o[best.params.slMode].skip), 2 * 3600e3);
      const poTest = stats(poSel(trigSide.filter((r) => !isTrain(r))), best.params.slMode, testD);
      const poTrain = stats(poSel(trigSide.filter(isTrain)), best.params.slMode, trainD);
      // ---- watch grid
      const wSide = ev.watch.filter((r) => r.side === side);
      const wgrid = [];
      for (const minF of [3, 4]) for (const minD of [1, 2]) for (const mode of WATCH_SL_MODES) {
        const sel = (rows) => dedupe(rows.filter((r) => r.n >= minF && r.d >= minD && r.o[mode] && !r.o[mode].skip), 4 * 3600e3);
        wgrid.push({ params: { minFactors: minF, minDirectional: minD, slMode: mode }, sel, train: stats(sel(wSide.filter(isTrain)), mode, trainD) });
      }
      const wbest = pick(wgrid);
      const wTest = stats(wbest.sel(wSide.filter((r) => !isTrain(r))), wbest.params.slMode, testD);
      const verdict = (test, train, ...bases) => {
        const ok = test.n >= MIN_OOS_N && test.expR >= 0.15 && train.expR > 0 && bases.every((b) => test.expR > b.expR + 0.1 && test.tp1Rate >= b.tp1Rate + 8);
        return { telegram: ok, reason: ok ? "OOS beats price-only and random" : test.n < MIN_OOS_N ? `OOS n=${test.n} < ${MIN_OOS_N}` : test.expR < 0.15 ? `OOS expectancy ${test.expR}R < 0.15R` : train.expR <= 0 ? "train expectancy <= 0" : "does not clearly beat baselines" };
      };
      report.tiers[`ignition_${side}`] = { params: best.params, train: best.train, test: ignTest, baselines: { priceOnlyTest: poTest, priceOnlyTrain: poTrain, randomTest: randTest, randomTrain: randTrain }, verdict: verdict(ignTest, best.train, poTest, randTest), grid: grid.map((g) => { const o = stats(g.sel(trigSide.filter((r) => !isTrain(r))), g.params.slMode, testD); return { ...g.params, n: g.train.n, expR: g.train.expR, tp1: g.train.tp1Rate, oosN: o.n, oosExpR: o.expR, oosTp1: o.tp1Rate }; }) };
      report.tiers[`watch_${side}`] = { params: wbest.params, train: wbest.train, test: wTest, baselines: { priceOnlyTest: poTest, randomTest: randTest }, verdict: verdict(wTest, wbest.train, poTest, randTest), grid: wgrid.map((g) => { const o = stats(g.sel(wSide.filter((r) => !isTrain(r))), g.params.slMode, testD); return { ...g.params, n: g.train.n, expR: g.train.expR, tp1: g.train.tp1Rate, oosN: o.n, oosExpR: o.expR, oosTp1: o.tp1Rate }; }) };
      // score-filtered subset search for ignition (5+ factors) — reported, only used if it passes on its own
      for (const minF of [5]) {
        const sel = (rows) => dedupe(rows.filter((r) => r.n >= minF && r.d >= 2 && r.o[best.params.slMode] && !r.o[best.params.slMode].skip), 2 * 3600e3);
        report.tiers[`ignition_${side}`][`subset_f${minF}`] = { train: stats(sel(trigSide.filter(isTrain)), best.params.slMode, trainD), test: stats(sel(trigSide.filter((r) => !isTrain(r))), best.params.slMode, testD) };
      }
    }
    for (const v of Object.values(report.tiers)) { v.test.days = report.data.testDays; v.train.days = report.data.trainDays; }
    writeFileSync(OUT, JSON.stringify(report, null, 1));
    // compact frozen config consumed by the live daemon (params + OOS stats + verdict; no grid)
    const cfg = { generatedAt: report.generatedAt, data: report.data, risk: report.risk, tiers: {} };
    for (const [k, v] of Object.entries(report.tiers)) cfg.tiers[k] = { params: v.params, train: v.train, test: v.test, baselines: { priceOnlyTest: v.baselines.priceOnlyTest, randomTest: v.baselines.randomTest }, verdict: v.verdict };
    if (!args.includes("--no-config")) writeFileSync(arg("config", "data/early-tier-config.json"), JSON.stringify(cfg, null, 1) + "\n");
    const f = (x) => `n=${x.n} (${x.perDay}/d) TP1 ${x.tp1Rate}% [${x.tp1Wilson}] E=${x.expR}R maxL=${x.maxConsecLoss} big=${x.bigRate}% med=${x.medRate}% SL~${x.avgSlPct}%`;
    console.log(`train ${report.data.from} → ${report.data.split} (${report.data.trainDays}d) | OOS → ${report.data.to} (${report.data.testDays}d)`);
    for (const [k, v] of Object.entries(report.tiers)) {
      console.log(`== ${k} params=${JSON.stringify(v.params)} → ${v.verdict.telegram ? "TELEGRAM ON" : "web-only"} (${v.verdict.reason})`);
      console.log(`   train ${f(v.train)}\n   OOS   ${f(v.test)}\n   price-only OOS ${f(v.baselines.priceOnlyTest)}\n   random OOS     ${f(v.baselines.randomTest)}`);
      if (v.subset_f5) console.log(`   subset f5 train ${f(v.subset_f5.train)} | OOS ${f(v.subset_f5.test)}`);
    }
  }
}
