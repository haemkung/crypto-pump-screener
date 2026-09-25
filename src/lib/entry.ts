/**
 * Heuristic entry-zone hints — research only, not trade signals.
 * v1: price/%/flag based (no kline fetch) for speed across ~700 symbols.
 */

import type { EntryHint, Flag, ShortEntryHint, ShortFlag } from "./types";

export type { EntryHint, EntryMode, ShortEntryHint, ShortEntryMode } from "./types";

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

  // Mid / pull bands are NOT entry signals — only early ต้นทาง is shown as entry.
  // Map former wait_pullback cases to neutral watch_only (หลักฐานซ่อนก่อน → ราคาเป็นแค่จังหวะ).
  if (decent && (inPullBand || (pct > 40 && pct <= 50 && fuel))) {
    return {
      mode: "watch_only",
      labelTh: "เฝ้าดู",
      entryLow: null,
      entryHigh: null,
      invalidation: "ยังไม่ใช่ต้นทาง — เฝ้าดูหลักฐานซ่อน / funding / วอลุ่ม ไม่ไล่หลังวิ่ง",
      entryNote: `24h +${pct.toFixed(0)}% นอกโซนต้นทาง — เฝ้าดูอย่างเดียว (ไม่ใช้ป้ายรอพัก)`,
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
        : "ยังไม่เข้าเงื่อนไขต้นทาง — เฝ้าดูอย่างเดียว",
  };
}



export interface ShortEntryHintInput {
  price: number;
  priceChangePercent: number;
  shortScore: number;
  shortFlags: ShortFlag[];
  lastFundingRate: number | null;
}

function hasLongSqueezeFuel(
  flags: ShortFlag[],
  funding: number | null
): boolean {
  if (flags.includes("positive_funding") || flags.includes("long_squeeze_fuel")) {
    return true;
  }
  return funding != null && funding > 0;
}

function decentShortSetup(flags: ShortFlag[], score: number): boolean {
  const structure =
    flags.includes("high_volume") ||
    flags.includes("thin_liquidity") ||
    flags.includes("oi_rising") ||
    flags.includes("catalyst") ||
    flags.includes("early_drop");
  return score >= 28 || structure;
}

/**
 * Short entry-zone heuristic — research only.
 * Invalidation is ABOVE the entry zone (or funding flips deeply negative on rebound).
 */
export function computeShortEntryHint(
  input: ShortEntryHintInput
): ShortEntryHint {
  const {
    price,
    priceChangePercent: pct,
    shortScore: score,
    shortFlags: flags,
    lastFundingRate,
  } = input;

  // late_short_chase flag marks < -35% risk, but entry "too late" is < -50%
  // (or -35…-50 without long-squeeze fuel). -20…-35 → wait_bounce.
  const clearlyTooLate = pct < -50;
  const fuel = hasLongSqueezeFuel(flags, lastFundingRate);
  const earlyFlag = flags.includes("early_drop");
  const inEarlyBand = pct <= -5 && pct >= -20;
  const inBounceBand = pct < -20 && pct >= -35;
  const decent = decentShortSetup(flags, score);

  // --- too_late_short ---
  if (clearlyTooLate) {
    return {
      mode: "too_late_short",
      labelTh: "ลงลึกแล้ว",
      entryLow: null,
      entryHigh: null,
      invalidation:
        "ไม่แนะนำไล่ Short — ราคาลงลึกแล้ว เสี่ยงเด้งแรง / short squeeze",
      entryNote: `24h ${pct.toFixed(0)}% ต่ำมาก — ไม่ไล่ Short`,
    };
  }

  // Mid deep drop (-35…-50) without fuel → too late; with fuel handled below as wait_bounce
  if (pct < -35 && pct >= -50 && !fuel) {
    return {
      mode: "too_late_short",
      labelTh: "ลงลึกแล้ว",
      entryLow: null,
      entryHigh: null,
      invalidation:
        "ไม่แนะนำไล่ Short — ลงแรงโดยไม่มี funding+ / long-squeeze fuel",
      entryNote: `24h ${pct.toFixed(0)}% แล้วและไม่มี crowded-long fuel — ไม่ไล่ Short`,
    };
  }

  // --- early_short ---
  if (decent && !clearlyTooLate && (earlyFlag || inEarlyBand) && fuel && pct >= -20 && pct <= -5) {
    // Small bounce band slightly above last, or tight around price
    const low = ROUND(price * 0.995);
    const high = ROUND(price * 1.015);
    return {
      mode: "early_short",
      labelTh: "ต้นทาง Short",
      entryLow: low,
      entryHigh: high,
      invalidation: `สูงกว่า ~${high} หรือ funding พลิกติดลบแรงขณะราคาเด้ง`,
      entryNote: earlyFlag
        ? "ต้นทาง Short: early_drop + funding+ — สนใจใกล้ราคา / เด้งเล็กน้อย"
        : "24h ในโซน ~-5 ถึง -20% และ funding บวก — สนใจใกล้ราคาปัจจุบัน",
    };
  }

  // Early drop without fuel but strong short score
  if (
    decent &&
    (earlyFlag || inEarlyBand) &&
    pct >= -20 &&
    pct <= -5 &&
    !fuel &&
    score >= 40
  ) {
    const low = ROUND(price * 0.995);
    const high = ROUND(price * 1.015);
    return {
      mode: "early_short",
      labelTh: "ต้นทาง Short",
      entryLow: low,
      entryHigh: high,
      invalidation: `สูงกว่า ~${high} หรือโมเมนตัมกลับตัวพร้อมวอลุ่ม`,
      entryNote:
        "ต้นทาง Short จากคะแนน/early_drop — ยังไม่มี funding+ ชัด ใช้เป็นโซนเฝ้า Short",
    };
  }

  // Bounce / mid-drop bands are NOT Short entry signals — only early ต้นทาง Short.
  if (decent && (inBounceBand || (pct < -35 && pct >= -50 && fuel))) {
    return {
      mode: "watch_only_short",
      labelTh: "เฝ้าดู",
      entryLow: null,
      entryHigh: null,
      invalidation: "ยังไม่ใช่ต้นทาง Short — เฝ้าดูหลักฐานซ่อน / funding+ ไม่ไล่ Short หลังลงแรง",
      entryNote: `24h ${pct.toFixed(0)}% นอกโซนต้นทาง Short — เฝ้าดูอย่างเดียว`,
    };
  }

  // --- watch_only_short ---
  return {
    mode: "watch_only_short",
    labelTh: "เฝ้าดู",
    entryLow: null,
    entryHigh: null,
    invalidation: "ยังไม่มีโซน Short ชัด — เฝ้าดู flags / funding+ / วอลุ่ม",
    entryNote:
      score < 28
        ? "สัญญาณ Short ผสม/อ่อน — เฝ้าดูอย่างเดียว"
        : "ยังไม่เข้าเงื่อนไขต้นทาง Short — เฝ้าดูอย่างเดียว",
  };
}
