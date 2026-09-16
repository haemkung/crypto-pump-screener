import { NextResponse } from "next/server";
import {
  readLearnedCases,
  computeLearningStatsFromCases,
} from "@/lib/learnedCases";
import { getNowThresholds } from "@/lib/learnedWeights";
import { computePaperPnlSummary } from "@/lib/learningStore";
import {
  NOW_LONG_MIN_SCORE,
  NOW_SHORT_MIN_SCORE,
  NOW_LONG_PCT_MAX,
  NOW_SHORT_PCT_MIN,
} from "@/lib/urgencyDefaults";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Rolling win-rate + effective NOW thresholds + paper P&L from continuous learning. */
export async function GET() {
  try {
    const cases = readLearnedCases();
    const t = getNowThresholds(true);
    const rollingN = t.learned?.rollingN ?? 30;
    const side = computeLearningStatsFromCases(cases, rollingN);
    const paper = computePaperPnlSummary(cases, rollingN);

    return NextResponse.json({
      updatedAt: new Date().toISOString(),
      rollingN,
      long: side.long,
      short: side.short,
      totalCases: side.totalCases,
      paperPnl: {
        longSum: paper.longSum,
        shortSum: paper.shortSum,
        totalSum: paper.totalSum,
        longAvg: paper.longAvg,
        shortAvg: paper.shortAvg,
        totalAvg: paper.totalAvg,
        longN: paper.longN,
        shortN: paper.shortN,
        totalN: paper.totalN,
      },
      /** Convenience aliases for UI */
      paperPnlPctSum: paper.totalSum,
      paperPnlPctAvg: paper.totalAvg,
      thresholds: {
        source: t.source,
        nowLongMinScore: t.longMinScore,
        nowShortMinScore: t.shortMinScore,
        nowLongPctMax: t.longPctMax,
        nowShortPctMin: t.shortPctMin,
        longDelta: t.learned?.long ?? null,
        shortDelta: t.learned?.short ?? null,
        defaults: {
          nowLongMinScore: NOW_LONG_MIN_SCORE,
          nowShortMinScore: NOW_SHORT_MIN_SCORE,
          nowLongPctMax: NOW_LONG_PCT_MAX,
          nowShortPctMin: NOW_SHORT_PCT_MIN,
        },
      },
      empty: side.totalCases === 0,
      emptyMessageTh:
        "ยังไม่มีเคสเรียนรู้ — รอประเมินอัตโนมัติหรือกดถูก/ผิด",
      disclaimerTh:
        "สถิติจากเกณฑ์ heuristic (15m/60m) — ไม่ใช่ผลตอบแทนจริง และไม่ใช่คำแนะนำการลงทุน",
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
