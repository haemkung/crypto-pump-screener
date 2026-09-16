/**
 * Heuristic entry-zone hints — research only, not trade signals.
 * v1: price/%/flag based (no kline fetch) for speed across ~700 symbols.
 */

import type { EntryHint, Flag } from "./types";

export type { EntryHint, EntryMode } from "./types";

export interface EntryHintInput {
  price: number;
  priceChangePercent: number;
  score: number;
  flags: Flag[];
  lastFundingRate: number | null;
}

const ROUND = (n: number) => {
  if (!Number.isFinite(n) || n <= 0) return n;
  if (n >= 1000) return Math.round(n * 100) / 100;
  if (n >= 1) return Math.round(n * 1e4) / 1e4;
  if (n >= 0.01) return Math.round(n * 1e6) / 1e6;
  return Math.round(n * 1e8) / 1e8;
};

function hasFuel(flags: Flag[], funding: number | null): boolean {
  if (flags.includes("neg_funding") || flags.includes("short_squeeze_fuel")) {
    return true;
  }
  return funding != null && funding < 0;
}

function decentSetup(flags: Flag[], score: number): boolean {
  const structure =
    flags.includes("high_volume") ||
    flags.includes("thin_liquidity") ||
    flags.includes("oi_rising") ||
    flags.includes("catalyst") ||
    flags.includes("early_move");
  return score >= 28 || structure;
}

/**
 * Compute entry-zone heuristic for one screened row.
 */
export function computeEntryHint(input: EntryHintInput): EntryHint {
  const { price, priceChangePercent: pct, score, flags, lastFundingRate } =
    input;
  const late = flags.includes("late_chase") || pct > 50;
  const fuel = hasFuel(flags, lastFundingRate);
  const earlyFlag = flags.includes("early_move");
  const inEarlyBand = pct >= 5 && pct <= 18;
  const inPullBand = pct > 18 && pct <= 40;
  const decent = decentSetup(flags, score);

  // --- too_late ---
  if (late) {
    return {
      mode: "too_late",
      labelTh: "สายแล้ว",
      entryLow: null,
      entryHigh: null,
      invalidation:
        "ไม่แนะนำไล่ราคา — รอพักลึกหรือตั้งการ์ดใหม่หลังโครงสร้างเปลี่ยน",
      entryNote:
        pct > 50
          ? `24h +${pct.toFixed(0)}% สูงมาก / late_chase — ไม่แนะนำไล่`
          : "ธง late_chase — ไม่แนะนำไล่ตาม",
    };
  }

  // Mid-chase without fuel → too late
  if (pct > 40 && pct <= 50 && !fuel) {
    return {
      mode: "too_late",
      labelTh: "สายแล้ว",
      entryLow: null,
      entryHigh: null,
      invalidation:
        "ไม่แนะนำไล่ — ราคาวิ่งไปไกลโดยไม่มี funding/squeeze fuel",
      entryNote: `24h +${pct.toFixed(0)}% แล้วและไม่มี short fuel — ไม่แนะนำไล่`,
    };
  }

  // --- early_entry ---
  if (decent && !late && (earlyFlag || inEarlyBand) && fuel && pct <= 18) {
    const low = ROUND(price * 0.985);
    const high = ROUND(price * 1.005);
    return {
      mode: "early_entry",
      labelTh: "ต้นทาง",
      entryLow: low,
      entryHigh: high,
      invalidation: `ต่ำกว่า ~${low} หรือ funding พลิกบวกแรงขณะราคาดิ่ง`,
      entryNote: earlyFlag
        ? "โซนต้นทาง: early_move + short fuel — สนใจใกล้ราคาปัจจุบัน"
        : "24h ในโซน ~5–18% และมี funding ติดลบ — สนใจใกล้ราคาปัจจุบัน",
    };
  }

  // Early-ish without fuel but strong score
  if (
    decent &&
    (earlyFlag || inEarlyBand) &&
    pct <= 18 &&
    !fuel &&
    score >= 40
  ) {
    const low = ROUND(price * 0.985);
    const high = ROUND(price * 1.005);
    return {
      mode: "early_entry",
      labelTh: "ต้นทาง",
      entryLow: low,
      entryHigh: high,
      invalidation: `ต่ำกว่า ~${low} หรือโมเมนตัมพังพร้อมวอลุ่ม`,
      entryNote:
        "ต้นทางจากคะแนน/early_move — ยังไม่มี funding− ชัด ใช้เป็นโซนเฝ้าเข้า",
    };
  }

  // --- wait_pullback ---
  if (decent && inPullBand) {
    const pullFrac = Math.min(0.08, Math.abs(pct) / 200);
    const low = ROUND(price * (1 - pullFrac));
    const high = ROUND(price * 0.97);
    const entryLow = Math.min(low, high);
    const entryHigh = Math.max(low, high);
    return {
      mode: "wait_pullback",
      labelTh: "รอพัก",
      entryLow,
      entryHigh,
      invalidation: `ต่ำกว่าโซนพัก (~${entryLow}) หรือ funding พลิกบวกแรงขณะราคาดิ่ง`,
      entryNote: `24h +${pct.toFixed(0)}% แล้ว — รอพักเข้าโซนประมาณ ${entryLow}–${entryHigh}`,
    };
  }

  // Mid 40–50 with fuel → wait deeper pullback
  if (decent && pct > 40 && pct <= 50 && fuel) {
    const pullFrac = Math.min(0.12, Math.abs(pct) / 200);
    const low = ROUND(price * (1 - pullFrac));
    const high = ROUND(price * 0.95);
    const entryLow = Math.min(low, high);
    const entryHigh = Math.max(low, high);
    return {
      mode: "wait_pullback",
      labelTh: "รอพัก",
      entryLow,
      entryHigh,
      invalidation: `ต่ำกว่าโซนพัก (~${entryLow}) — ระวังไล่หลังวิ่งแรง`,
      entryNote: `วิ่งแรง (+${pct.toFixed(0)}%) แต่ยังมี short fuel — รอพักลึกกว่านี้`,
    };
  }

  // --- watch_only ---
  return {
    mode: "watch_only",
    labelTh: "เฝ้าดู",
    entryLow: null,
    entryHigh: null,
    invalidation: "ยังไม่มีโซนเข้าชัด — เฝ้าดู flags / funding / วอลุ่ม",
    entryNote:
      score < 28
        ? "สัญญาณผสม/อ่อน — เฝ้าดูอย่างเดียว"
        : "ยังไม่เข้าเงื่อนไขต้นทางหรือรอพักชัด — เฝ้าดูอย่างเดียว",
  };
}
