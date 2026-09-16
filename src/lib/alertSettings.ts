/**
 * Telegram alert filter settings — data/alert-settings.json (gitignored).
 * mode 'sharp' = high-confidence only; 'all' = every NOW alert.
 * minGrade: sharp default 'A' (allow strong B).
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  NOW_LONG_MIN_SCORE,
  NOW_SHORT_MIN_SCORE,
} from "./urgencyDefaults";
import type { QualityGrade } from "./types";

export type AlertMode = "all" | "sharp";

export interface AlertSettings {
  mode: AlertMode;
  /** Absolute min score for sharp long (default: NOW_LONG_MIN_SCORE + 5) */
  minLongScore: number;
  /** Absolute min score for sharp short (default: NOW_SHORT_MIN_SCORE + 5) */
  minShortScore: number;
  /** Skip side temporarily when learned WR known and below this (0–1). Default 0.35 */
  poorWrSkipBelow: number;
  /** Sharp mode: mainly send this grade and above (A default; strong B allowed) */
  minGrade: QualityGrade;
  updatedAt: string | null;
}

const DATA_DIR = resolve(process.cwd(), "data");
const SETTINGS_PATH = resolve(DATA_DIR, "alert-settings.json");

export function defaultAlertSettings(): AlertSettings {
  return {
    mode: "sharp",
    minLongScore: NOW_LONG_MIN_SCORE + 5,
    minShortScore: NOW_SHORT_MIN_SCORE + 5,
    poorWrSkipBelow: 0.35,
    minGrade: "A",
    updatedAt: null,
  };
}

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function parseGrade(v: unknown, fallback: QualityGrade): QualityGrade {
  if (v === "A" || v === "B" || v === "C") return v;
  return fallback;
}

/** Read settings; create sharp defaults on disk if missing. */
export function readAlertSettings(createIfMissing = true): AlertSettings {
  const defaults = defaultAlertSettings();
  if (!existsSync(SETTINGS_PATH)) {
    if (createIfMissing) {
      const created = { ...defaults, updatedAt: new Date().toISOString() };
      ensureDataDir();
      writeFileSync(
        SETTINGS_PATH,
        JSON.stringify(created, null, 2) + "\n",
        "utf8"
      );
      return created;
    }
    return defaults;
  }
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
    const mode: AlertMode = raw?.mode === "all" ? "all" : "sharp";
    return {
      mode,
      minLongScore:
        typeof raw?.minLongScore === "number"
          ? raw.minLongScore
          : defaults.minLongScore,
      minShortScore:
        typeof raw?.minShortScore === "number"
          ? raw.minShortScore
          : defaults.minShortScore,
      poorWrSkipBelow:
        typeof raw?.poorWrSkipBelow === "number"
          ? raw.poorWrSkipBelow
          : defaults.poorWrSkipBelow,
      minGrade: parseGrade(raw?.minGrade, defaults.minGrade),
      updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : null,
    };
  } catch {
    return defaults;
  }
}

export function writeAlertSettings(
  patch: Partial<AlertSettings>
): AlertSettings {
  const current = readAlertSettings(true);
  const next: AlertSettings = {
    ...current,
    ...patch,
    mode: patch.mode === "all" || patch.mode === "sharp" ? patch.mode : current.mode,
    minGrade: parseGrade(patch.minGrade ?? current.minGrade, current.minGrade),
    updatedAt: new Date().toISOString(),
  };
  if (typeof patch.minLongScore === "number") {
    next.minLongScore = patch.minLongScore;
  }
  if (typeof patch.minShortScore === "number") {
    next.minShortScore = patch.minShortScore;
  }
  if (typeof patch.poorWrSkipBelow === "number") {
    next.poorWrSkipBelow = patch.poorWrSkipBelow;
  }
  ensureDataDir();
  writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}
