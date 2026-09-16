import { NextResponse } from "next/server";
import {
  readLearnedCases,
  computeLearningStatsFromCases,
} from "@/lib/learnedCases";
import { getNowThresholds } from "@/lib/learnedWeights";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Rolling win-rate + effective NOW thresholds from continuous learning. */
export async function GET() {
  try {
    const cases = readLearnedCases();
    const t = getNowThresholds(true);
    const rollingN = t.learned?.rollingN ?? 30;
    const side = computeLearningStatsFromCases(cases, rollingN);

    return NextResponse.json({
      updatedAt: new Date().toISOString(),
      rollingN,
      long: side.long,
      short: side.short,
      totalCases: side.totalCases,
      thresholds: {
        source: t.source,
        nowLongMinScore: t.longMinScore,
        nowShortMinScore: t.shortMinScore,
        nowLongPctMax: t.longPctMax,
        nowShortPctMin: t.shortPctMin,
        longDelta: t.learned?.long ?? null,
        shortDelta: t.learned?.short ?? null,
      },
      disclaimerTh:
        "สถิติจากเกณฑ์ heuristic (15m/60m) — ไม่ใช่ผลตอบแทนจริง และไม่ใช่คำแนะนำการลงทุน",
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
