/**
 * BTC/ETH market regime — heuristic only, not financial advice.
 * Cached aggressively; uses bulk tickers + optional short kline momentum.
 */

import { cacheGet, cacheSet } from "./cache";
import { getFuturesTickers, getKlines } from "./binance";
import type { MarketRegime, RegimeKind } from "./types";

const REGIME_TTL = 60_000;
const RISK_OFF_BTC_24H = -3;
const RISK_ON_BTC_24H = 2;
const THIN_VOL_USDT = 5_000_000;

export function isThinOrSmallCap(row: {
  quoteVolume: number;
  flags?: string[];
  shortFlags?: string[];
  hasSpot?: boolean;
}): boolean {
  if (row.quoteVolume < THIN_VOL_USDT) return true;
  if (row.flags?.includes("thin_liquidity") || row.flags?.includes("no_spot"))
    return true;
  if (
    row.shortFlags?.includes("thin_liquidity") ||
    row.shortFlags?.includes("no_spot")
  )
    return true;
  if (row.hasSpot === false) return true;
  return false;
}

function classify(
  btc24h: number,
  eth24h: number,
  btcShort: number | null,
  ethShort: number | null
): RegimeKind {
  if (btc24h <= RISK_OFF_BTC_24H) return "risk_off";
  if (
    btc24h >= RISK_ON_BTC_24H &&
    eth24h >= 0 &&
    (btcShort == null || btcShort >= -0.5) &&
    (ethShort == null || ethShort >= -0.8)
  ) {
    return "risk_on";
  }
  if (btc24h < -1.5 && (btcShort != null && btcShort < -0.8)) return "risk_off";
  if (eth24h <= -4 && btc24h < 0) return "risk_off";
  if (ethShort != null && ethShort <= -1.5 && btc24h < 0) return "risk_off";
  return "neutral";
}

function klineMomPct(
  closes: number[]
): number | null {
  if (closes.length < 3) return null;
  const last = closes[closes.length - 1];
  const prior = closes[closes.length - 3];
  if (!Number.isFinite(last) || !Number.isFinite(prior) || prior === 0) return null;
  return ((last - prior) / prior) * 100;
}

export async function getMarketRegime(opts?: {
  forceRefresh?: boolean;
  /** Optional pre-fetched ticker map to avoid extra bulk call */
  tickerPct?: Map<string, number>;
}): Promise<MarketRegime> {
  const cacheKey = "regime:v1";
  if (!opts?.forceRefresh) {
    const hit = cacheGet<MarketRegime>(cacheKey);
    if (hit) return hit;
  }

  let btc24h = 0;
  let eth24h = 0;
  if (opts?.tickerPct) {
    btc24h = opts.tickerPct.get("BTCUSDT") ?? 0;
    eth24h = opts.tickerPct.get("ETHUSDT") ?? 0;
  } else {
    try {
      const tickers = await getFuturesTickers();
      for (const t of tickers) {
        if (t.symbol === "BTCUSDT") btc24h = Number(t.priceChangePercent) || 0;
        if (t.symbol === "ETHUSDT") eth24h = Number(t.priceChangePercent) || 0;
      }
    } catch {
      // keep zeros
    }
  }

  let btcShort: number | null = null;
  let ethShort: number | null = null;
  try {
    const [btcK, ethK] = await Promise.all([
      getKlines("BTCUSDT", "15m", 6),
      getKlines("ETHUSDT", "15m", 6),
    ]);
    btcShort = klineMomPct(btcK.map((k) => k.close));
    ethShort = klineMomPct(ethK.map((k) => k.close));
  } catch {
    // short mom optional
  }

  const kind = classify(btc24h, eth24h, btcShort, ethShort);
  const labelTh =
    kind === "risk_on"
      ? "Risk-on"
      : kind === "risk_off"
        ? "Risk-off"
        : "Neutral";

  const regime: MarketRegime = {
    kind,
    labelTh,
    btc24h,
    eth24h,
    btcShortMom: btcShort,
    ethShortMom: ethShort,
    updatedAt: new Date().toISOString(),
  };
  cacheSet(cacheKey, regime, REGIME_TTL);
  return regime;
}

/**
 * Whether Long NOW should be dampened/blocked under risk-off for thin names.
 * Returns { block, penalty } — block only if score below escape hatch.
 */
export function longNowRegimeGate(
  regime: MarketRegime,
  score: number,
  thin: boolean
): { block: boolean; penalty: number; noteTh: string | null } {
  if (regime.kind !== "risk_off") {
    return { block: false, penalty: 0, noteTh: null };
  }
  if (!thin) {
    return {
      block: false,
      penalty: 1,
      noteTh: "BTC risk-off — Long ระวัง",
    };
  }
  // thin / small-cap under risk-off: block unless score very high
  if (score < 72) {
    return {
      block: true,
      penalty: 3,
      noteTh: "Risk-off + thin liq — บล็อก Long NOW",
    };
  }
  return {
    block: false,
    penalty: 2,
    noteTh: "Risk-off + thin แต่ score สูง — ผ่านแบบระวัง",
  };
}
