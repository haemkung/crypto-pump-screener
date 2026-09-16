/**
 * PatternScore (0–100) — heuristic only, from available fields.
 * Never invent missing numbers: absent data contributes 0 and is noted.
 *
 * Components (approx weights):
 * - earlyMove   ~25  : 24h% in ~5–25% sweet spot; >50% late/chase penalty tag
 * - volume      ~30  : quoteVolume percentile among USDT perps
 * - funding     ~20  : negative lastFundingRate = short fuel
 * - liquidity   ~15  : high fut/spot ratio OR no-spot thin flag (flag only if no ratio)
 * - oiChange    ~10  : positive OI % change over recent hist (if fetched)
 *
 * Flags are separate labels; score still reflects only real numbers.
 */

import type { Flag, ScoreBreakdown } from "./types";

export interface ScoreInput {
  priceChangePercent: number;
  quoteVolume: number;
  /** Percentile 0–100 among filtered universe; null if unknown */
  volumePercentile: number | null;
  lastFundingRate: number | null;
  futSpotRatio: number | null;
  hasSpot: boolean;
  oiChangePct: number | null;
  hasCatalyst: boolean;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function computePatternScore(input: ScoreInput): {
  score: number;
  flags: Flag[];
  breakdown: ScoreBreakdown;
} {
  const notes: string[] = [];
  const flags: Flag[] = [];
  const pct = input.priceChangePercent;

  // --- Early move (~25) ---
  let earlyMove = 0;
  if (pct >= 5 && pct <= 25) {
    // Peak around 12–18%
    const mid = 15;
    earlyMove = 25 * (1 - Math.abs(pct - mid) / 15);
    earlyMove = clamp(earlyMove, 12, 25);
    flags.push("early_move");
    notes.push(`Early move: 24h ${pct.toFixed(1)}% ในโซน 5–25%`);
  } else if (pct > 25 && pct <= 50) {
    earlyMove = clamp(18 - (pct - 25) * 0.4, 4, 18);
    notes.push(`Move กำลังแรง: 24h ${pct.toFixed(1)}% (ยังไม่ถึง late มาก)`);
  } else if (pct > 50) {
    earlyMove = 2;
    flags.push("late_chase");
    notes.push(`Late/chase: 24h ${pct.toFixed(1)}% > 50% — ระวังไล่ราคา`);
  } else if (pct > 0 && pct < 5) {
    earlyMove = pct; // mild credit
    notes.push(`Move อ่อน: 24h ${pct.toFixed(1)}%`);
  } else {
    notes.push(`ไม่มี early-move bonus (24h ${pct.toFixed(1)}%)`);
  }

  // --- Volume (~30) ---
  let volume = 0;
  if (input.volumePercentile != null) {
    const p = input.volumePercentile;
    volume = clamp((p / 100) * 30, 0, 30);
    if (p >= 80) {
      flags.push("high_volume");
      notes.push(`วอลุ่มสูง: percentile ~${p.toFixed(0)}th`);
    } else {
      notes.push(`วอลุ่ม percentile ~${p.toFixed(0)}th`);
    }
  } else {
    notes.push("ไม่มี volume percentile");
  }

  // --- Funding (~20) ---
  let funding = 0;
  if (input.lastFundingRate != null) {
    const fr = input.lastFundingRate;
    // Typical FR ~ -0.001 to 0.001 (i.e. -0.1% to 0.1%)
    if (fr < 0) {
      // More negative → more short fuel, cap at 20
      const mag = Math.abs(fr);
      funding = clamp((mag / 0.001) * 12, 4, 20);
      flags.push("neg_funding");
      flags.push("short_squeeze_fuel");
      notes.push(`Funding ติดลบ: ${(fr * 100).toFixed(4)}% — short fuel`);
    } else if (fr === 0) {
      notes.push("Funding = 0");
    } else {
      funding = 0;
      notes.push(`Funding บวก: ${(fr * 100).toFixed(4)}% — ไม่ช่วย squeeze setup`);
    }
  } else {
    notes.push("ไม่มี funding data");
  }

  // --- Liquidity / thin proxy (~15) ---
  let liquidity = 0;
  if (!input.hasSpot) {
    flags.push("no_spot");
    flags.push("thin_liquidity");
    liquidity = 10; // structural thin flag — modest points, not invented ratio
    notes.push("ไม่มีคู่ spot บน Binance — thin liquidity flag");
  } else if (input.futSpotRatio != null && Number.isFinite(input.futSpotRatio)) {
    const r = input.futSpotRatio;
    if (r >= 3) {
      liquidity = clamp(8 + Math.min(r, 20) * 0.35, 8, 15);
      flags.push("thin_liquidity");
      notes.push(`Fut/Spot สูง: ${r.toFixed(2)}x — สภาพคล่องบาง (proxy)`);
    } else if (r >= 1.5) {
      liquidity = clamp(r * 3, 3, 10);
      notes.push(`Fut/Spot: ${r.toFixed(2)}x`);
    } else {
      liquidity = clamp(r * 2, 0, 5);
      notes.push(`Fut/Spot ต่ำ: ${r.toFixed(2)}x`);
    }
  } else {
    notes.push("ไม่มี fut/spot ratio");
  }

  // --- OI change (~10) ---
  let oiChange = 0;
  if (input.oiChangePct != null && Number.isFinite(input.oiChangePct)) {
    const oi = input.oiChangePct;
    if (oi > 0) {
      oiChange = clamp((oi / 15) * 10, 1, 10);
      if (oi >= 5) {
        flags.push("oi_rising");
        notes.push(`OI เพิ่มขึ้น ~${oi.toFixed(1)}% (หน้าต่าง hist ล่าสุด)`);
      } else {
        notes.push(`OI เปลี่ยน ~${oi.toFixed(1)}%`);
      }
    } else {
      notes.push(`OI ลด/นิ่ง ~${oi.toFixed(1)}%`);
    }
  } else {
    notes.push("ยังไม่มี OI hist (lazy / rate-limit)");
  }

  if (input.hasCatalyst) {
    flags.push("catalyst");
    notes.push("มี catalyst note (static) สำหรับสัญลักษณ์นี้");
  }

  const total = clamp(
    Math.round(earlyMove + volume + funding + liquidity + oiChange),
    0,
    100
  );

  const breakdown: ScoreBreakdown = {
    earlyMove: Math.round(earlyMove * 10) / 10,
    volume: Math.round(volume * 10) / 10,
    funding: Math.round(funding * 10) / 10,
    liquidity: Math.round(liquidity * 10) / 10,
    oiChange: Math.round(oiChange * 10) / 10,
    total,
    notes,
  };

  return { score: total, flags: [...new Set(flags)], breakdown };
}

/** Rank volumes → percentile 0–100 (higher volume = higher percentile). */
export function volumePercentiles(volumes: number[]): number[] {
  const n = volumes.length;
  if (n === 0) return [];
  const indexed = volumes.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const out = new Array<number>(n);
  indexed.forEach((item, rank) => {
    out[item.i] = n === 1 ? 100 : (rank / (n - 1)) * 100;
  });
  return out;
}
