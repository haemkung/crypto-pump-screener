import { proxyToUpstream } from "@/lib/upstreamProxy";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Rolling win-rate + effective NOW thresholds + paper P&L from continuous learning. */
export async function GET() {
  try {
    const proxied = await proxyToUpstream("/api/learning-stats");
    if (proxied) return proxied;

    const [
      { readLearnedCases, computeLearningStatsFromCases },
      { getNowThresholds },
      { computePaperPnlSummary },
      {
        NOW_LONG_MIN_SCORE,
        NOW_SHORT_MIN_SCORE,
        NOW_LONG_PCT_MAX,
        NOW_SHORT_PCT_MIN,
      },
    ] = await Promise.all([
      import("@/lib/learnedCases"),
      import("@/lib/learnedWeights"),
      import("@/lib/learningStore"),
      import("@/lib/urgencyDefaults"),
    ]);

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
        "ยังไม่มีเคสเรียนรู้ — ระบบประเมินจากราคาอัตโนมัติ (ไม่ต้องกดเอง)",
      disclaimerTh:
        "สถิติจากเกณฑ์ heuristic (5m/15m/60m อัตโนมัติ) — ไม่ใช่ผลตอบแทนจริง และไม่ใช่คำแนะนำการลงทุน",
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
