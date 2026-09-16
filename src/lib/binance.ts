/**
 * Server-side Binance public API helpers.
 * All browser traffic goes through Next.js API routes to avoid CORS.
 *
 * NOTE: Direct fapi.binance.com / api.binance.com may return HTTP 451 from
 * restricted regions (e.g. some US cloud IPs). www.binance.com often still
 * serves the same REST paths — we try primary hosts then fall back.
 */

import { cacheGetOrSet } from "./cache";
import type {
  FuturesTicker24hr,
  PremiumIndex,
  SpotTicker24hr,
  OIHistPoint,
} from "./types";

const FAPI_HOSTS = [
  "https://www.binance.com",
  "https://fapi.binance.com",
];
const SPOT_HOSTS = [
  "https://data-api.binance.vision",
  "https://www.binance.com",
  "https://api.binance.com",
];

const BULK_TTL = 45_000;
const DETAIL_TTL = 60_000;

async function fetchJsonFromHosts<T>(
  path: string,
  hosts: string[],
  opts?: { preferHost?: string }
): Promise<T> {
  const ordered = opts?.preferHost
    ? [opts.preferHost, ...hosts.filter((h) => h !== opts.preferHost)]
    : hosts;
  let lastErr: unknown;
  for (const host of ordered) {
    const url = `${host}${path}`;
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        lastErr = new Error(`Binance ${res.status}: ${url} ${text.slice(0, 180)}`);
        // try next host on geo / ban / 5xx
        if ([418, 429, 451, 403, 502, 503].includes(res.status)) continue;
        throw lastErr;
      }
      return (await res.json()) as T;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** USDT-M perpetual only: ends with USDT, no underscore (excludes dated quarterlies). */
export function isUsdtPerpetual(symbol: string): boolean {
  return symbol.endsWith("USDT") && !symbol.includes("_");
}

export function baseFromSymbol(symbol: string): string {
  return symbol.endsWith("USDT") ? symbol.slice(0, -4) : symbol;
}

export async function getFuturesTickers(): Promise<FuturesTicker24hr[]> {
  return cacheGetOrSet("fapi:ticker24hr", BULK_TTL, () =>
    fetchJsonFromHosts<FuturesTicker24hr[]>("/fapi/v1/ticker/24hr", FAPI_HOSTS)
  );
}

export async function getPremiumIndex(): Promise<PremiumIndex[]> {
  return cacheGetOrSet("fapi:premiumIndex", BULK_TTL, () =>
    fetchJsonFromHosts<PremiumIndex[]>("/fapi/v1/premiumIndex", FAPI_HOSTS)
  );
}

export async function getSpotTickers(): Promise<SpotTicker24hr[]> {
  return cacheGetOrSet("spot:ticker24hr", BULK_TTL, () =>
    fetchJsonFromHosts<SpotTicker24hr[]>("/api/v3/ticker/24hr", SPOT_HOSTS)
  );
}

export async function getOpenInterest(symbol: string): Promise<{
  symbol: string;
  openInterest: string;
  time: number;
}> {
  return cacheGetOrSet(`oi:${symbol}`, DETAIL_TTL, () =>
    fetchJsonFromHosts(
      `/fapi/v1/openInterest?symbol=${encodeURIComponent(symbol)}`,
      FAPI_HOSTS
    )
  );
}

export async function getOpenInterestHist(
  symbol: string,
  period: "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "6h" | "12h" | "1d" = "1h",
  limit = 12
): Promise<OIHistPoint[]> {
  const key = `oiHist:${symbol}:${period}:${limit}`;
  return cacheGetOrSet(key, DETAIL_TTL, () =>
    fetchJsonFromHosts<OIHistPoint[]>(
      `/futures/data/openInterestHist?symbol=${encodeURIComponent(symbol)}&period=${period}&limit=${limit}`,
      FAPI_HOSTS
    )
  );
}

export async function getGlobalLongShortAccountRatio(
  symbol: string,
  period = "1h",
  limit = 1
): Promise<{ longShortRatio: string; longAccount: string; shortAccount: string; timestamp: number }[]> {
  const key = `glsar:${symbol}:${period}:${limit}`;
  return cacheGetOrSet(key, DETAIL_TTL, () =>
    fetchJsonFromHosts(
      `/futures/data/globalLongShortAccountRatio?symbol=${encodeURIComponent(symbol)}&period=${period}&limit=${limit}`,
      FAPI_HOSTS
    )
  );
}

export async function getTopLongShortPositionRatio(
  symbol: string,
  period = "1h",
  limit = 1
): Promise<{ longShortRatio: string; longAccount: string; shortAccount: string; timestamp: number }[]> {
  const key = `tlspr:${symbol}:${period}:${limit}`;
  return cacheGetOrSet(key, DETAIL_TTL, () =>
    fetchJsonFromHosts(
      `/futures/data/topLongShortPositionRatio?symbol=${encodeURIComponent(symbol)}&period=${period}&limit=${limit}`,
      FAPI_HOSTS
    )
  );
}

export async function getTakerLongShortRatio(
  symbol: string,
  period = "1h",
  limit = 1
): Promise<{ buySellRatio: string; buyVol: string; sellVol: string; timestamp: number }[]> {
  const key = `tlsr:${symbol}:${period}:${limit}`;
  return cacheGetOrSet(key, DETAIL_TTL, () =>
    fetchJsonFromHosts(
      `/futures/data/takerlongshortRatio?symbol=${encodeURIComponent(symbol)}&period=${period}&limit=${limit}`,
      FAPI_HOSTS
    )
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch OI hist for a limited set of symbols with small stagger.
 * Failures return null for that symbol (never invent numbers).
 */
export async function batchOiChangePct(
  symbols: string[],
  concurrency = 4
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  for (let i = 0; i < symbols.length; i += concurrency) {
    const chunk = symbols.slice(i, i + concurrency);
    await Promise.all(
      chunk.map(async (sym) => {
        try {
          const hist = await getOpenInterestHist(sym, "1h", 6);
          if (!hist || hist.length < 2) {
            out.set(sym, null);
            return;
          }
          const oldest = Number(hist[0].sumOpenInterest);
          const newest = Number(hist[hist.length - 1].sumOpenInterest);
          if (!Number.isFinite(oldest) || !Number.isFinite(newest) || oldest <= 0) {
            out.set(sym, null);
            return;
          }
          out.set(sym, ((newest - oldest) / oldest) * 100);
        } catch {
          out.set(sym, null);
        }
      })
    );
    if (i + concurrency < symbols.length) {
      await sleep(100);
    }
  }
  return out;
}

export type KlineInterval = "5m" | "15m" | "1h" | "4h" | "1d";

export interface KlineBar {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

/** Futures klines — cached per symbol/interval/limit. */
export async function getKlines(
  symbol: string,
  interval: KlineInterval = "15m",
  limit = 48
): Promise<KlineBar[]> {
  const key = `klines:${symbol}:${interval}:${limit}`;
  return cacheGetOrSet(key, DETAIL_TTL, async () => {
    const raw = await fetchJsonFromHosts<unknown[][]>(
      `/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`,
      FAPI_HOSTS
    );
    return raw.map((row) => ({
      openTime: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
      closeTime: Number(row[6]),
    }));
  });
}
