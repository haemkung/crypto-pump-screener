/**
 * Build the full screen dataset: tickers + funding + spot ratio.
 * OI enrichment is optional (oiTopN) so the default path stays fast.
 * MTF / regime / quality / false-patterns enrich only a limited batch.
 */

import {
  getFuturesTickers,
  getPremiumIndex,
  getSpotTickers,
  isUsdtPerpetual,
  baseFromSymbol,
  batchOiChangePct,
} from "./binance";
import { computePatternScore, computeShortScore, volumePercentiles } from "./scoring";
import { computeEntryHint, computeShortEntryHint } from "./entry";
import { applySweepGate, computeUrgency } from "./urgency";
import { batchConfirmSweep, SWEEP_BATCH_CAP } from "./sweep";
import { getCatalystNote } from "./catalysts";
import { getMarketRegime } from "./regime";
import { batchMtfConfirm } from "./mtf";
import { matchFalsePatterns } from "./falsePatterns";
import { gradeRow } from "./qualityGrade";
import type {
  Flag,
  MtfAlign,
  ScreenResponse,
  ScreenRow,
  ShortFlag,
} from "./types";
import { cacheGet, cacheSet } from "./cache";

const SCREEN_TTL = 45_000;
const DEFAULT_OI_TOP_N = 0; // fast path — client lazy-enriches
const MTF_BATCH_LIMIT = 30;

const MTF_FLAGS: MtfAlign[] = ["mtf_align", "mtf_mixed", "mtf_against"];

function stripMtfAndFalse(flags: Flag[]): Flag[] {
  return flags.filter(
    (f) =>
      f !== "mtf_align" &&
      f !== "mtf_mixed" &&
      f !== "mtf_against" &&
      f !== "false_pattern_risk"
  );
}

function stripMtfAndFalseShort(flags: ShortFlag[]): ShortFlag[] {
  return flags.filter(
    (f) =>
      f !== "mtf_align" &&
      f !== "mtf_mixed" &&
      f !== "mtf_against" &&
      f !== "false_pattern_risk"
  );
}

export async function buildScreen(options?: {
  oiTopN?: number;
  forceRefresh?: boolean;
  /** Skip MTF batch (tests / ultra-fast) */
  skipMtf?: boolean;
}): Promise<ScreenResponse> {
  const oiTopN = options?.oiTopN ?? DEFAULT_OI_TOP_N;
  const cacheKey = `screen:v7:${oiTopN}:${options?.skipMtf ? "nomtf" : "mtf"}`;
  if (!options?.forceRefresh) {
    const hit = cacheGet<ScreenResponse>(cacheKey);
    if (hit) return hit;
  }

  const warnings: string[] = [];
  const [tickers, premiums, spotResult] = await Promise.all([
    getFuturesTickers(),
    getPremiumIndex(),
    getSpotTickers()
      .then((rows) => ({ ok: true as const, rows }))
      .catch((e) => {
        warnings.push(`Spot ticker unavailable: ${String(e)}`);
        return { ok: false as const, rows: [] as Awaited<ReturnType<typeof getSpotTickers>> };
      }),
  ]);

  const spotOk = spotResult.ok;
  const spotTickers = spotResult.rows;

  const premiumMap = new Map(
    premiums.filter((p) => isUsdtPerpetual(p.symbol)).map((p) => [p.symbol, p])
  );

  const spotVolMap = new Map<string, number>();
  for (const s of spotTickers) {
    if (s.symbol.endsWith("USDT") && !s.symbol.includes("_")) {
      spotVolMap.set(s.symbol, Number(s.quoteVolume) || 0);
    }
  }

  const perps = tickers.filter((t) => isUsdtPerpetual(t.symbol));

  const sortedByVol = [...perps].sort(
    (a, b) => Number(b.quoteVolume) - Number(a.quoteVolume)
  );
  const volumes = sortedByVol.map((t) => Number(t.quoteVolume) || 0);
  const percentiles = volumePercentiles(volumes);
  const percentileBySymbol = new Map(
    sortedByVol.map((t, i) => [t.symbol, percentiles[i]])
  );

  let oiMap = new Map<string, number | null>();
  if (oiTopN > 0) {
    const oiTargets = sortedByVol.slice(0, oiTopN).map((t) => t.symbol);
    try {
      oiMap = await batchOiChangePct(oiTargets, 4);
    } catch (e) {
      warnings.push(`OI batch failed: ${String(e)}`);
    }
  }

  const tickerPct = new Map<string, number>();
  for (const t of perps) {
    tickerPct.set(t.symbol, Number(t.priceChangePercent) || 0);
  }

  let regime = null;
  try {
    regime = await getMarketRegime({
      forceRefresh: options?.forceRefresh,
      tickerPct,
    });
  } catch (e) {
    warnings.push(`Regime fetch failed: ${String(e)}`);
  }

  // Pass 1: base scores + provisional urgency (no MTF yet)
  type Draft = ScreenRow & {
    _mtfLong: MtfAlign | null;
    _mtfShort: MtfAlign | null;
  };

  const drafts: Draft[] = sortedByVol.map((t) => {
    const symbol = t.symbol;
    const price = Number(t.lastPrice) || 0;
    const priceChangePercent = Number(t.priceChangePercent) || 0;
    const quoteVolume = Number(t.quoteVolume) || 0;
    const prem = premiumMap.get(symbol);
    const lastFundingRate =
      prem && prem.lastFundingRate !== undefined
        ? Number(prem.lastFundingRate)
        : null;
    const markPrice =
      prem && prem.markPrice !== undefined ? Number(prem.markPrice) : null;

    const hasSpot = spotOk ? spotVolMap.has(symbol) : true;
    const spotVol = spotOk && spotVolMap.has(symbol) ? spotVolMap.get(symbol)! : null;
    const futSpotRatio =
      spotOk && spotVol != null && spotVol > 0 ? quoteVolume / spotVol : null;

    const oiChangePct = oiMap.has(symbol) ? oiMap.get(symbol)! : null;
    const catalystNote = getCatalystNote(symbol);

    const fundingFinite = Number.isFinite(lastFundingRate as number)
      ? lastFundingRate
      : null;

    const scoreInput = {
      priceChangePercent,
      quoteVolume,
      volumePercentile: percentileBySymbol.get(symbol) ?? null,
      lastFundingRate: fundingFinite,
      futSpotRatio,
      hasSpot: spotOk ? hasSpot : true,
      oiChangePct,
      hasCatalyst: Boolean(catalystNote),
    };

    const { score, flags, breakdown } = computePatternScore(scoreInput);
    const { shortScore, shortFlags, shortBreakdown } =
      computeShortScore(scoreInput);

    const entry = computeEntryHint({
      price,
      priceChangePercent,
      score,
      flags,
      lastFundingRate: fundingFinite,
    });

    const shortEntry = computeShortEntryHint({
      price,
      priceChangePercent,
      shortScore,
      shortFlags,
      lastFundingRate: fundingFinite,
    });

    const urgencyFields = computeUrgency({
      priceChangePercent,
      score,
      flags,
      entry,
      shortScore,
      shortFlags,
      shortEntry,
      quoteVolume,
      hasSpot: spotOk ? hasSpot : true,
      regime,
    });

    return {
      symbol,
      baseAsset: baseFromSymbol(symbol),
      price,
      priceChangePercent,
      quoteVolume,
      lastFundingRate: fundingFinite,
      markPrice: Number.isFinite(markPrice as number) ? markPrice : null,
      futuresVol: quoteVolume,
      spotVol,
      futSpotRatio,
      hasSpot: spotOk ? hasSpot : true,
      oiChangePct,
      longShortRatio: null,
      score,
      flags,
      breakdown,
      entry,
      shortScore,
      shortFlags,
      shortBreakdown,
      shortEntry,
      catalystNote,
      ...urgencyFields,
      mtfAlign: null,
      qualityGrade: "C" as const,
      shortQualityGrade: "C" as const,
      falsePatternRisk: false,
      _mtfLong: null,
      _mtfShort: null,
    };
  });

  // Select MTF targets: provisional NOW + top by max(score, shortScore)
  let mtfEnriched = 0;
  if (!options?.skipMtf) {
    const byScore = [...drafts].sort(
      (a, b) =>
        Math.max(b.score, b.shortScore) - Math.max(a.score, a.shortScore)
    );
    const nowSyms = drafts.filter((r) => r.urgency).map((r) => r.symbol);
    const topSyms = byScore.slice(0, MTF_BATCH_LIMIT).map((r) => r.symbol);
    const targets = [...new Set([...nowSyms, ...topSyms])].slice(
      0,
      MTF_BATCH_LIMIT
    );

    try {
      const mtfMap = await batchMtfConfirm(targets, {
        limit: MTF_BATCH_LIMIT,
        concurrency: 3,
      });
      mtfEnriched = mtfMap.size;
      for (const d of drafts) {
        const m = mtfMap.get(d.symbol);
        if (!m) continue;
        d._mtfLong = m.longAlign;
        d._mtfShort = m.shortAlign;
      }
    } catch (e) {
      warnings.push(`MTF batch failed: ${String(e)}`);
    }
  }

  // Pass 2: apply MTF flags, false patterns, recompute urgency + grades
  const rows: ScreenRow[] = drafts.map((d) => {
    let flags = stripMtfAndFalse(d.flags);
    let shortFlags = stripMtfAndFalseShort(d.shortFlags);

    const fpLong = matchFalsePatterns(flags, "long");
    const fpShort = matchFalsePatterns(shortFlags, "short");

    if (d._mtfLong) {
      flags = [...flags, d._mtfLong as Flag];
    }
    if (d._mtfShort) {
      shortFlags = [...shortFlags, d._mtfShort as ShortFlag];
    }
    if (fpLong.matched) {
      flags = [...flags, "false_pattern_risk"];
    }
    if (fpShort.matched) {
      shortFlags = [...shortFlags, "false_pattern_risk"];
    }

    const urgencyFields = computeUrgency({
      priceChangePercent: d.priceChangePercent,
      score: d.score,
      flags,
      entry: d.entry,
      shortScore: d.shortScore,
      shortFlags,
      shortEntry: d.shortEntry,
      quoteVolume: d.quoteVolume,
      hasSpot: d.hasSpot,
      mtfLong: d._mtfLong,
      mtfShort: d._mtfShort,
      regime,
      falsePatternLong: fpLong.matched,
      falsePatternShort: fpShort.matched,
      falsePatternBlockLong: fpLong.blockNow,
      falsePatternBlockShort: fpShort.blockNow,
    });

    const { qualityGrade, shortQualityGrade } = gradeRow(
      { ...d, flags, shortFlags },
      d._mtfLong,
      d._mtfShort,
      regime,
      fpLong.matched,
      fpShort.matched
    );

    // Prefer MTF align matching urgency side for display
    let mtfAlign: MtfAlign | null = d._mtfLong;
    if (urgencyFields.urgency === "now_short") mtfAlign = d._mtfShort;
    else if (urgencyFields.urgency === "now_long") mtfAlign = d._mtfLong;
    else if (d.shortScore > d.score) mtfAlign = d._mtfShort;

    const falsePatternRisk =
      urgencyFields.urgency === "now_short" ? fpShort.matched : fpLong.matched;

    // Drop unused MTF_FLAGS helper lint
    void MTF_FLAGS;

    const { _mtfLong: _l, _mtfShort: _s, ...rest } = d;
    void _l;
    void _s;

    return {
      ...rest,
      flags,
      shortFlags,
      ...urgencyFields,
      mtfAlign,
      qualityGrade,
      shortQualityGrade,
      falsePatternRisk,
    };
  });

  // Opposite-side SL sweep gate. Only NOW candidates (capped) hit klines.
  // Anything not confirmed — including unfetched overflow and fetch errors —
  // becomes "รอกิน SL อีกฝั่ง", never เข้าตอนนี้.
  let sweepChecked = 0;
  const nowIdx: number[] = [];
  rows.forEach((r, i) => {
    if (r.urgency === "now_long" || r.urgency === "now_short") nowIdx.push(i);
  });
  nowIdx.sort((ia, ib) => {
    const a = rows[ia];
    const b = rows[ib];
    return Math.max(b.score, b.shortScore) - Math.max(a.score, a.shortScore);
  });
  const checkIdx = nowIdx.slice(0, SWEEP_BATCH_CAP);
  const skipIdx = nowIdx.slice(SWEEP_BATCH_CAP);
  try {
    const sweepMap = await batchConfirmSweep(checkIdx.map((i) => rows[i].symbol));
    sweepChecked = sweepMap.size;
    for (const i of checkIdx) {
      const r = rows[i];
      const side = r.urgency === "now_short" ? "short" : "long";
      const hit = sweepMap.get(r.symbol);
      const confirmed = hit
        ? side === "long"
          ? hit.longSwept
          : hit.shortSwept
        : false;
      const gated = applySweepGate(
        {
          urgency: r.urgency,
          urgencyLabelTh: r.urgencyLabelTh,
          urgencyReasonTh: r.urgencyReasonTh,
          missRiskTh: r.missRiskTh,
        },
        { confirmed, interval: confirmed ? hit?.interval ?? null : null }
      );
      r.urgency = gated.urgency;
      r.urgencyLabelTh = gated.urgencyLabelTh;
      r.urgencyReasonTh = gated.urgencyReasonTh;
      r.missRiskTh = gated.missRiskTh;
      r.sweepConfirmed = confirmed && (gated.urgency === "now_long" || gated.urgency === "now_short");
    }
  } catch (e) {
    warnings.push(`Sweep batch failed: ${String(e)}`);
    for (const i of checkIdx) {
      const r = rows[i];
      const gated = applySweepGate(
        {
          urgency: r.urgency,
          urgencyLabelTh: r.urgencyLabelTh,
          urgencyReasonTh: r.urgencyReasonTh,
          missRiskTh: r.missRiskTh,
        },
        { confirmed: false }
      );
      r.urgency = gated.urgency;
      r.urgencyLabelTh = gated.urgencyLabelTh;
      r.urgencyReasonTh = gated.urgencyReasonTh;
      r.missRiskTh = gated.missRiskTh;
      r.sweepConfirmed = false;
    }
  }
  for (const i of skipIdx) {
    const r = rows[i];
    const gated = applySweepGate(
      {
        urgency: r.urgency,
        urgencyLabelTh: r.urgencyLabelTh,
        urgencyReasonTh: r.urgencyReasonTh,
        missRiskTh: r.missRiskTh,
      },
      { confirmed: false }
    );
    r.urgency = gated.urgency;
    r.urgencyLabelTh = gated.urgencyLabelTh;
    r.urgencyReasonTh = gated.urgencyReasonTh;
    r.missRiskTh = gated.missRiskTh;
    r.sweepConfirmed = false;
  }

  rows.sort((a, b) => b.score - a.score);

  const response: ScreenResponse = {
    updatedAt: new Date().toISOString(),
    cacheTtlSec: Math.round(SCREEN_TTL / 1000),
    rows,
    meta: {
      futuresPairs: perps.length,
      spotMatched: spotOk ? rows.filter((r) => r.hasSpot).length : 0,
      oiEnriched: [...oiMap.values()].filter((v) => v != null).length,
      mtfEnriched,
      sweepChecked,
      warnings,
      regime,
    },
  };

  cacheSet(cacheKey, response, SCREEN_TTL);
  return response;
}
