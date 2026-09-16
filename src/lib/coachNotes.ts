/**
 * Post-trade coach notes (Thai) — appended after grading.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

export interface CoachNote {
  id: string;
  symbol: string;
  side: "long" | "short";
  outcome: "win" | "loss" | "neutral";
  noteTh: string;
  timestamp: string;
  alertId?: string;
  horizon?: string;
  movePct?: number;
}

export interface CoachNotesFile {
  notes: CoachNote[];
}

const DATA_DIR = resolve(process.cwd(), "data");
const PATH = resolve(DATA_DIR, "coach-notes.json");
const MAX_NOTES = 80;

function ensure() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(PATH)) {
    writeFileSync(PATH, JSON.stringify({ notes: [] }, null, 2) + "\n", "utf8");
  }
}

export function readCoachNotes(): CoachNotesFile {
  ensure();
  try {
    const raw = JSON.parse(readFileSync(PATH, "utf8"));
    return { notes: Array.isArray(raw?.notes) ? raw.notes : [] };
  } catch {
    return { notes: [] };
  }
}

export function writeCoachNotes(file: CoachNotesFile): void {
  ensure();
  const notes = file.notes.slice(-MAX_NOTES);
  writeFileSync(
    PATH,
    JSON.stringify({ notes }, null, 2) + "\n",
    "utf8"
  );
}

/** Build a short Thai coach tip from a graded outcome. */
export function buildCoachNoteTh(opts: {
  symbol: string;
  side: "long" | "short";
  outcome: "win" | "loss" | "neutral";
  movePct: number;
  horizon?: string;
  flags?: string[];
}): string {
  const sideTh = opts.side === "long" ? "Long" : "Short";
  const dir = opts.movePct >= 0 ? "+" : "";
  const hz = opts.horizon ? ` (${opts.horizon})` : "";
  const flagHint =
    opts.flags && opts.flags.length
      ? ` · flags: ${opts.flags.slice(0, 3).join(",")}`
      : "";

  if (opts.outcome === "win") {
    return `✅ ${opts.symbol} ${sideTh}${hz}: ทำงานได้ — ราคา ${dir}${opts.movePct.toFixed(2)}% ตรงทิศ${flagHint}. เก็บแพทเทิร์นที่คล้ายไว้`;
  }
  if (opts.outcome === "loss") {
    const tip =
      opts.flags?.includes("thin_liquidity") || opts.flags?.includes("late_chase")
        ? " ระวัง thin/late ในครั้งหน้า"
        : " ทบทวน MTF + regime ก่อนเข้า";
    return `❌ ${opts.symbol} ${sideTh}${hz}: พลาด — ราคา ${dir}${opts.movePct.toFixed(2)}%${flagHint}.${tip}`;
  }
  return `➖ ${opts.symbol} ${sideTh}${hz}: ยังไม่ชัด — ราคา ${dir}${opts.movePct.toFixed(2)}% รอข้อมูลเพิ่ม`;
}

export function appendCoachNote(
  partial: Omit<CoachNote, "id" | "timestamp"> & { timestamp?: string }
): CoachNote {
  const file = readCoachNotes();
  const note: CoachNote = {
    id: randomUUID(),
    timestamp: partial.timestamp || new Date().toISOString(),
    symbol: partial.symbol,
    side: partial.side,
    outcome: partial.outcome,
    noteTh: partial.noteTh,
    alertId: partial.alertId,
    horizon: partial.horizon,
    movePct: partial.movePct,
  };
  file.notes.push(note);
  writeCoachNotes(file);
  return note;
}
