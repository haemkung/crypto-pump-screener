/**
 * False-signal memory from learned losses — flag co-occurrence patterns.
 * Heuristic only; not financial advice.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { resolve } from "node:path";
import { cacheGet, cacheSet } from "./cache";

export interface FalsePattern {
  id: string;
  /** Sorted unique flag keys that must all be present */
  flags: string[];
  side: "long" | "short" | "any";
  hits: number;
  /** If true, matching pattern blocks NOW urgency */
  blockNow: boolean;
  noteTh?: string;
}

export interface FalsePatternsFile {
  updatedAt: string | null;
  patterns: FalsePattern[];
}

const DATA_DIR = resolve(process.cwd(), "data");
const PATH = resolve(DATA_DIR, "false-patterns.json");
const CACHE_KEY = "false-patterns:v1";
const CACHE_TTL = 30_000;

const SEED: FalsePatternsFile = {
  updatedAt: null,
  patterns: [
    {
      id: "thin_late_long",
      flags: ["thin_liquidity", "late_chase"],
      side: "long",
      hits: 0,
      blockNow: true,
      noteTh: "Thin + Late มักพลาด Long",
    },
    {
      id: "thin_late_short",
      flags: ["thin_liquidity", "late_short_chase"],
      side: "short",
      hits: 0,
      blockNow: true,
      noteTh: "Thin + Late Short มักพลาด",
    },
    {
      id: "no_spot_late",
      flags: ["no_spot", "late_chase"],
      side: "long",
      hits: 0,
      blockNow: true,
      noteTh: "No Spot + Late",
    },
  ],
};

function ensure() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(PATH)) {
    writeFileSync(PATH, JSON.stringify(SEED, null, 2) + "\n", "utf8");
  }
}

export function readFalsePatterns(): FalsePatternsFile {
  const hit = cacheGet<FalsePatternsFile>(CACHE_KEY);
  if (hit) return hit;
  ensure();
  try {
    const raw = JSON.parse(readFileSync(PATH, "utf8")) as FalsePatternsFile;
    if (!raw?.patterns || !Array.isArray(raw.patterns)) {
      cacheSet(CACHE_KEY, SEED, CACHE_TTL);
      return SEED;
    }
    cacheSet(CACHE_KEY, raw, CACHE_TTL);
    return raw;
  } catch {
    return SEED;
  }
}

export function writeFalsePatterns(file: FalsePatternsFile): void {
  ensure();
  writeFileSync(PATH, JSON.stringify(file, null, 2) + "\n", "utf8");
  cacheSet(CACHE_KEY, file, CACHE_TTL);
}

export interface FalsePatternMatch {
  matched: boolean;
  blockNow: boolean;
  patternIds: string[];
  noteTh: string | null;
}

export function matchFalsePatterns(
  flags: string[],
  side: "long" | "short"
): FalsePatternMatch {
  const file = readFalsePatterns();
  const set = new Set(flags);
  const hits: FalsePattern[] = [];
  for (const p of file.patterns) {
    if (p.side !== "any" && p.side !== side) continue;
    if (p.flags.length === 0) continue;
    if (p.flags.every((f) => set.has(f))) hits.push(p);
  }
  if (hits.length === 0) {
    return { matched: false, blockNow: false, patternIds: [], noteTh: null };
  }
  return {
    matched: true,
    blockNow: hits.some((h) => h.blockNow),
    patternIds: hits.map((h) => h.id),
    noteTh: hits.map((h) => h.noteTh || h.id).join("; "),
  };
}

/**
 * Aggregate failing flag pairs from alert-log losses + learned-cases.
 * Merges into false-patterns.json (keeps seeds, bumps hits).
 */
export function rebuildFalsePatternsFromLosses(opts?: {
  alertLog?: { alerts?: Array<{ side?: string; flags?: string[]; outcomes?: Record<string, string | null> }> };
  cases?: Array<{ outcome?: string; side?: string; alertId?: string }>;
}): FalsePatternsFile {
  const file = readFalsePatterns();
  const pairCounts = new Map<string, { flags: string[]; side: "long" | "short"; n: number }>();

  const alerts = opts?.alertLog?.alerts ?? [];
  for (const a of alerts) {
    const outs = a.outcomes || {};
    const lost = Object.values(outs).some((o) => o === "loss");
    if (!lost) continue;
    const flags = [...new Set((a.flags || []).filter(Boolean))].sort();
    if (flags.length < 2) continue;
    const side = a.side === "short" ? "short" : "long";
    // all pairs
    for (let i = 0; i < flags.length; i++) {
      for (let j = i + 1; j < flags.length; j++) {
        const pair = [flags[i], flags[j]];
        const key = `${side}|${pair.join("+")}`;
        const prev = pairCounts.get(key);
        if (prev) prev.n++;
        else pairCounts.set(key, { flags: pair, side, n: 1 });
      }
    }
  }

  for (const [key, v] of pairCounts) {
    if (v.n < 1) continue;
    const id = `auto_${key.replace(/\|/g, "_").replace(/\+/g, "_")}`;
    const existing = file.patterns.find((p) => p.id === id);
    if (existing) {
      existing.hits = Math.max(existing.hits, v.n);
    } else if (v.n >= 2) {
      file.patterns.push({
        id,
        flags: v.flags,
        side: v.side,
        hits: v.n,
        blockNow: v.n >= 3,
        noteTh: `แพทเทิร์นเสียซ้ำ: ${v.flags.join("+")}`,
      });
    }
  }

  // bump seed hits when match appears in pairCounts
  for (const p of file.patterns) {
    if (!p.id.startsWith("auto_")) {
      const key = `${p.side}|${[...p.flags].sort().join("+")}`;
      const found = pairCounts.get(key);
      if (found) p.hits = Math.max(p.hits, found.n);
    }
  }

  file.updatedAt = new Date().toISOString();
  writeFalsePatterns(file);
  return file;
}
