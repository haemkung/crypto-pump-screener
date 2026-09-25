import { proxyToUpstream, isCloudflareWorkersRuntime } from "@/lib/upstreamProxy";
import { NextRequest, NextResponse } from "next/server";
import { withCors, corsPreflight } from "@/lib/cors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function OPTIONS(req: NextRequest) {
  return corsPreflight(req) || new NextResponse(null, { status: 204 });
}

/** GET /api/learning-insights — live mistake-learner output for UI */
export async function GET(req: NextRequest) {
  try {
    const proxied = await proxyToUpstream("/api/learning-insights");
    if (proxied) return withCors(req, proxied);

    if (await isCloudflareWorkersRuntime()) {
      return withCors(
        req,
        NextResponse.json(
          {
            updatedAt: new Date().toISOString(),
            empty: true,
            mistakes: [],
            wins: [],
            adjustments: [],
            meta: {
              softFail: true,
              reason: "BOT_UPSTREAM unavailable; insights live on bot disk",
            },
            disclaimerTh:
              "เรียนรู้จากผล Early จริง — ใช้ปรับ AI/โค้ช ไม่ใช่คำแนะนำการลงทุน",
          },
          { status: 200, headers: { "Cache-Control": "no-store" } }
        )
      );
    }

    const { readLearningInsights, readEarlyLearnedBias } = await import(
      "@/lib/learningInsights"
    );
    const insights = readLearningInsights();
    const bias = readEarlyLearnedBias();
    if (!insights) {
      return withCors(
        req,
        NextResponse.json({
          updatedAt: new Date().toISOString(),
          empty: true,
          mistakes: [],
          wins: [],
          adjustments: [],
          emptyMessageTh:
            "ยังไม่มีบทเรียน — รอ evaluate + learn-from-mistakes หลังเกรด Early",
          disclaimerTh:
            "เรียนรู้จากผล Early จริง — ใช้ปรับ AI/โค้ช ไม่ใช่คำแนะนำการลงทุน",
        })
      );
    }

    return withCors(
      req,
      NextResponse.json({
        ...insights,
        empty: false,
        bias: bias || insights.biasSummary || null,
      })
    );
  } catch (e) {
    return withCors(
      req,
      NextResponse.json({ error: String(e) }, { status: 500 })
    );
  }
}
