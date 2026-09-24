/**
 * Early tiers snapshot (written by scripts/early-ignition-daemon.mjs on the bot machine).
 * Small JSON — safe to proxy through Workers without buffering concerns.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface EarlyFactor {
  key: string;
  labelTh?: string;
  detailTh: string;
}

export interface EarlyTierRow {
  id: string;
  type: "watch" | "ignition";
  tier?: "accumulation" | "distribution";
  symbol: string;
  side: "long" | "short";
  price: number;
  pct24h?: number | null;
  factors: EarlyFactor[];
  factorCount: number;
  directional?: number;
  flaggedAt: string;
  firstFlaggedAt: string;
  telegram: "sent" | "off" | "capped" | "failed";
  trigger?: { moveWindow: number; movePct: number; volMult: number; breakoutPct: number } | null;
  plan?: { entry: number; sl: number; slPct: number; tp1: number; tp2: number; slSkip: boolean; slNoteTh?: string } | null;
  trade?: { tp1: boolean; tp2: boolean; r: number } | null;
}

export interface EarlyTiersFile {
  updatedAt: string | null;
  daemonAt?: string | null;
  rules?: Record<string, number>;
  telegram?: Record<string, boolean>;
  risk?: Record<string, number>;
  tiers?: Record<string, unknown>;
  backtest?: unknown;
  live?: Record<string, unknown>;
  watch: EarlyTierRow[];
  ignition: EarlyTierRow[];
  noteTh?: string;
}

export function readEarlyTiers(): EarlyTiersFile {
  const p = resolve(process.cwd(), "data", "early-tiers.json");
  if (!existsSync(p)) return { updatedAt: null, watch: [], ignition: [], noteTh: "daemon ยังไม่เขียนข้อมูล" };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<EarlyTiersFile>;
    return {
      updatedAt: raw.updatedAt ?? null,
      daemonAt: raw.daemonAt ?? null,
      rules: raw.rules,
      telegram: raw.telegram,
      risk: raw.risk,
      tiers: raw.tiers,
      backtest: raw.backtest,
      live: raw.live,
      watch: Array.isArray(raw.watch) ? raw.watch : [],
      ignition: Array.isArray(raw.ignition) ? raw.ignition : [],
      noteTh: raw.noteTh,
    };
  } catch {
    return { updatedAt: null, watch: [], ignition: [], noteTh: "อ่านไฟล์ early-tiers ไม่ได้" };
  }
}
