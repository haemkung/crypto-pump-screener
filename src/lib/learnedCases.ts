/**
 * Read helpers for data/learned-cases.json (graded alert outcomes).
 * Server-only (uses fs) — do not import from client components.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { LearnedCase } from "./types";

export type { LearnedCase, LearnedOutcome } from "./types";

const CASES_PATH = resolve(process.cwd(), "data", "learned-cases.json");

export function readLearnedCases(): LearnedCase[] {
  if (!existsSync(CASES_PATH)) return [];
  try {
    const raw = JSON.parse(readFileSync(CASES_PATH, "utf8"));
    return Array.isArray(raw) ? (raw as LearnedCase[]) : [];
  } catch {
    return [];
  }
}

export interface SourceBucketStats {
  total: number;
  wins: number;
  losses: number;
  neutrals: number;
  graded: number;
  winRate: number | null;
}

export interface LearningStats {
  updatedAt: string;
  rollingN: number;
  long: { wins: number; losses: number; neutrals: number; graded: number; winRate: number | null };
  short: { wins: number; losses: number; neutrals: number; graded: number; winRate: number | null };
  totalCases: number;
  bySource?: {
    early: SourceBucketStats;
    now: SourceBucketStats;
  };
  thresholds: {
    source: string;
    nowLongMinScore: number;
    nowShortMinScore: number;
    nowLongPctMax: number;
    nowShortPctMin: number;
  };
}


function bucketStats(list: LearnedCase[]): SourceBucketStats {
  const wins = list.filter((c) => c.outcome === "win").length;
  const losses = list.filter((c) => c.outcome === "loss").length;
  const neutrals = list.filter((c) => c.outcome === "neutral").length;
  const graded = wins + losses;
  return {
    total: list.length,
    wins,
    losses,
    neutrals,
    graded,
    winRate: graded > 0 ? wins / graded : null,
  };
}

/** Split Early (ระยะต้น) vs NOW (auto/manual/legacy) case counts. */
export function computeSourceSplit(cases: LearnedCase[]): {
  early: SourceBucketStats;
  now: SourceBucketStats;
} {
  const early = cases.filter((c) => c.source === "early");
  const now = cases.filter((c) => c.source !== "early");
  return { early: bucketStats(early), now: bucketStats(now) };
}

export function computeLearningStatsFromCases(
  cases: LearnedCase[],
  rollingN = 30
): Pick<LearningStats, "long" | "short" | "totalCases"> {
  const graded = cases
    .filter((c) => c.outcome === "win" || c.outcome === "loss")
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

  function sideStats(side: "long" | "short") {
    const slice = graded.filter((c) => c.side === side).slice(0, rollingN);
    const wins = slice.filter((c) => c.outcome === "win").length;
    const losses = slice.filter((c) => c.outcome === "loss").length;
    const neutrals = cases.filter(
      (c) => c.side === side && c.outcome === "neutral"
    ).length;
    const gradedCount = wins + losses;
    return {
      wins,
      losses,
      neutrals,
      graded: gradedCount,
      winRate: gradedCount > 0 ? wins / gradedCount : null,
    };
  }

  return {
    long: sideStats("long"),
    short: sideStats("short"),
    totalCases: cases.length,
  };
}
