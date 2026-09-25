/**
 * Read data/learning-insights.json (mistake learner output).
 * Server-only — do not import from client components.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const PATH = resolve(process.cwd(), "data", "learning-insights.json");
const BIAS_PATH = resolve(process.cwd(), "data", "early-learned-bias.json");

export interface LearningMistake {
  side: string;
  factorKeys: string[];
  losses: number;
  wins: number;
  winRate: number | null;
  noteTh: string;
  tipTh?: string;
}

export interface LearningAdjustment {
  key: string;
  value: number;
  noteTh: string;
}

export interface LearningInsightsFile {
  updatedAt: string;
  stats?: {
    earlyGraded?: number;
    earlyWins?: number;
    earlyLosses?: number;
    earlyWinRate?: number | null;
    confluenceAlerts?: number;
    casesTotal?: number;
  };
  mistakes?: LearningMistake[];
  wins?: Array<{
    side: string;
    factorKeys: string[];
    wins: number;
    losses: number;
    winRate: number | null;
    noteTh: string;
  }>;
  adjustments?: LearningAdjustment[];
  biasSummary?: {
    vetoBias?: number;
    cautionCount?: number;
    preferBoostCount?: number;
    minFactorsFloor?: number;
    maxSlPct?: number;
  };
  aiFewShot?: Array<{ lessonTh?: string; outcome?: string }>;
  disclaimerTh?: string;
}

export function readLearningInsights(): LearningInsightsFile | null {
  if (!existsSync(PATH)) return null;
  try {
    return JSON.parse(readFileSync(PATH, "utf8")) as LearningInsightsFile;
  } catch {
    return null;
  }
}

export function readEarlyLearnedBias(): Record<string, unknown> | null {
  if (!existsSync(BIAS_PATH)) return null;
  try {
    return JSON.parse(readFileSync(BIAS_PATH, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}
