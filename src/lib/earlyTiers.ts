/**
 * Early tiers snapshot (written by scripts/early-ignition-daemon.mjs on the bot machine).
 * Small JSON — safe to proxy through Workers without buffering concerns.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";


export interface EarlyAiReview {
  action: "send" | "boost" | "veto";
  score: number;
  reasonTh: string;
  model?: string | null;
  latencyMs?: number;
  ok?: boolean;
  skipped?: boolean;
  cached?: boolean;
}

export interface EarlyFactor {
  key: string;
  labelTh?: string;
  detailTh: string;
}

export type PreOrderStatus = "watching" | "waiting_ai" | "approved" | "vetoed" | "expired";

export interface EarlyTierRow {
  id: string;
  type: "watch" | "ignition" | "preOrder";
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
  telegram: "sent" | "off" | "capped" | "failed" | "sl_wide" | "ai_veto";
  ai?: EarlyAiReview | null;
  trigger?: { moveWindow: number; movePct: number; volMult: number; breakoutPct: number } | null;
  plan?: { entry: number; sl: number; slPct: number; tp1: number; tp2: number; slSkip: boolean; slNoteTh?: string } | null;
  trade?: { tp1: boolean; tp2: boolean; r: number } | null;
  /** Pre-order lifecycle: จ้องอยู่ → รอ AI → อนุมัติแล้ว / วีโต้ / หมดอายุ */
  status?: PreOrderStatus | null;
  statusTh?: string | null;
  source?: string | null;
  noteTh?: string | null;
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
  /** กำลังจ้อง / พร้อมโจมตี — not entered yet */
  preOrder?: EarlyTierRow[];
  watch: EarlyTierRow[];
  ignition: EarlyTierRow[];
  noteTh?: string;
}

export function readEarlyTiers(): EarlyTiersFile {
  const p = resolve(process.cwd(), "data", "early-tiers.json");
  if (!existsSync(p)) return { updatedAt: null, preOrder: [], watch: [], ignition: [], noteTh: "daemon ยังไม่เขียนข้อมูล" };
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
      preOrder: Array.isArray(raw.preOrder) ? raw.preOrder : [],
      watch: Array.isArray(raw.watch) ? raw.watch : [],
      ignition: Array.isArray(raw.ignition) ? raw.ignition : [],
      noteTh: raw.noteTh,
    };
  } catch {
    return { updatedAt: null, preOrder: [], watch: [], ignition: [], noteTh: "อ่านไฟล์ early-tiers ไม่ได้" };
  }
}
