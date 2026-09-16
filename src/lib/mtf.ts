/**
 * Multi-timeframe momentum align (5m / 15m / 1h) — limited batch only.
 * Heuristic research, not financial advice.
 */

import { getKlines, sleep } from "./binance";
import { cacheGet, cacheSet } from "./cache";
import type { MtfAlign } from "./types";

const MTF_TTL = 45_000;
const DEFAULT_BATCH = 30;
const CONCURRENCY = 3;

export interface MtfResult {
  align: MtfAlign;
  mom5m: number | null;
  mom15m: number | null;
  mom1h: number | null;
}

function closeMom(closes: number[]): number | null {
  if (closes.length < 2) return null;
  const last = closes[closes.length - 1];
  const prior = closes[closes.length - 2];
  if (!Number.isFinite(last) || !Number.isFinite(prior) || prior === 0) return null;
  return ((last - prior) / prior) * 100;
}

function sign(n: number | null): -1 | 0 | 1 {
  if (n == null || !Number.isFinite(n)) return 0;
  if (n > 0.05) return 1;
  if (n < -0.05) return -1;
  return 0;
}

/** sideBias: 1 = long (want up), -1 = short (want down) */
export function classifyMtf(
  mom5m: number | null,
  mom15m: number | null,
  mom1h: number | null,
  sideBias: 1 | -1
): MtfAlign {
  const signs = [sign(mom5m), sign(mom15m), sign(mom1h)].filter((s) => s !== 0);
  if (signs.length === 0) return "mtf_mixed";

  const want = sideBias;
  const aligned = signs.filter((s) => s === want).length;
  const against = signs.filter((s) => s === -want).length;

  if (against > 0 && aligned === 0) return "mtf_against";
  if (against >= 2) return "mtf_against";
  if (aligned >= 2 && against === 0) return "mtf_align";
  if (aligned >= 1 && against === 0) return "mtf_align";
  return "mtf_mixed";
}

export async function computeMtfForSymbol(
  symbol: string,
  sideBias: 1 | -1 = 1
): Promise<MtfResult> {
  const cacheKey = `mtf:${symbol}`;
  const hit = cacheGet<Omit<MtfResult, "align"> & { mom5m: number | null }>(cacheKey);
  let mom5m: number | null;
  let mom15m: number | null;
  let mom1h: number | null;
  if (hit) {
    mom5m = hit.mom5m;
    mom15m = hit.mom15m;
    mom1h = hit.mom1h;
  } else {
    try {
      const [k5, k15, k1h] = await Promise.all([
        getKlines(symbol, "5m", 3),
        getKlines(symbol, "15m", 3),
        getKlines(symbol, "1h", 3),
      ]);
      mom5m = closeMom(k5.map((k) => k.close));
      mom15m = closeMom(k15.map((k) => k.close));
      mom1h = closeMom(k1h.map((k) => k.close));
      cacheSet(cacheKey, { mom5m, mom15m, mom1h }, MTF_TTL);
    } catch {
      return {
        align: "mtf_mixed",
        mom5m: null,
        mom15m: null,
        mom1h: null,
      };
    }
  }
  return {
    align: classifyMtf(mom5m, mom15m, mom1h, sideBias),
    mom5m,
    mom15m,
    mom1h,
  };
}

/**
 * Batch MTF for a limited set of symbols. Returns map of symbol →
 * { longAlign, shortAlign, moms }.
 */
export async function batchMtfConfirm(
  symbols: string[],
  opts?: { concurrency?: number; limit?: number }
): Promise<
  Map<
    string,
    {
      longAlign: MtfAlign;
      shortAlign: MtfAlign;
      mom5m: number | null;
      mom15m: number | null;
      mom1h: number | null;
    }
  >
> {
  const limit = opts?.limit ?? DEFAULT_BATCH;
  const concurrency = opts?.concurrency ?? CONCURRENCY;
  const list = [...new Set(symbols)].slice(0, limit);
  const out = new Map<
    string,
    {
      longAlign: MtfAlign;
      shortAlign: MtfAlign;
      mom5m: number | null;
      mom15m: number | null;
      mom1h: number | null;
    }
  >();

  for (let i = 0; i < list.length; i += concurrency) {
    const chunk = list.slice(i, i + concurrency);
    await Promise.all(
      chunk.map(async (sym) => {
        const longRes = await computeMtfForSymbol(sym, 1);
        const shortAlign = classifyMtf(
          longRes.mom5m,
          longRes.mom15m,
          longRes.mom1h,
          -1
        );
        out.set(sym, {
          longAlign: longRes.align,
          shortAlign,
          mom5m: longRes.mom5m,
          mom15m: longRes.mom15m,
          mom1h: longRes.mom1h,
        });
      })
    );
    if (i + concurrency < list.length) await sleep(80);
  }
  return out;
}
