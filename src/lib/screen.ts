/**
 * Build the full screen dataset: tickers + funding + spot ratio.
 * OI enrichment is optional (oiTopN) so the default path stays fast.
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
import { getCatalystNote } from "./catalysts";
import type { ScreenResponse, ScreenRow } from "./types";
import { cacheGet, cacheSet } from "./cache";

const SCREEN_TTL = 45_000;
const DEFAULT_OI_TOP_N = 0; // fast path — client lazy-enriches

export async function buildScreen(options?: {
  oiTopN?: number;
  forceRefresh?: boolean;
}): Promise<ScreenResponse> {
  const oiTopN = options?.oiTopN ?? DEFAULT_OI_TOP_N;
  const cacheKey = `screen:v4:${oiTopN}`;
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

  const rows: ScreenRow[] = sortedByVol.map((t) => {
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

    // Only assert hasSpot when spot universe loaded successfully
    const hasSpot = spotOk ? spotVolMap.has(symbol) : true; // assume spot exists if unknown — don't false-flag
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
      // If spot API down, pass hasSpot=true so we don't mass-tag thin_liquidity
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
    };
  });

  rows.sort((a, b) => b.score - a.score);

  const response: ScreenResponse = {
    updatedAt: new Date().toISOString(),
    cacheTtlSec: Math.round(SCREEN_TTL / 1000),
    rows,
    meta: {
      futuresPairs: perps.length,
      spotMatched: spotOk ? rows.filter((r) => r.hasSpot).length : 0,
      oiEnriched: [...oiMap.values()].filter((v) => v != null).length,
      warnings,
    },
  };

  cacheSet(cacheKey, response, SCREEN_TTL);
  return response;
}
