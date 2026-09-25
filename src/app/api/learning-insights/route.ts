import { proxyToUpstream, isCloudflareWorkersRuntime } from "@/lib/upstreamProxy";
import { NextRequest, NextResponse } from "next/server";
import { withCors, corsPreflight } from "@/lib/cors";
import {
  EDGE_LEARNING_INSIGHTS_CACHE_URL,
  stashEdgeLastGood,
  matchEdgeLastGood,
} from "@/lib/edgeLastGood";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let lastGood: { text: string; at: number } | null = null;
const LAST_GOOD_MAX_AGE_MS = 24 * 3600e3;

export async function OPTIONS(req: NextRequest) {
  return corsPreflight(req) || new NextResponse(null, { status: 204 });
}

function emptyInsights(reason: string) {
  return {
    updatedAt: new Date().toISOString(),
    empty: true,
    mistakes: [],
    wins: [],
    adjustments: [],
    meta: { softFail: true, reason },
    noteTh: "ข้อมูลค้าง — ยังไม่มีบทเรียนล่าสุด",
    disclaimerTh:
      "เรียนรู้จากผล Early จริง — ใช้ปรับ AI/โค้ช ไม่ใช่คำแนะนำการลงทุน",
  };
}

/** GET /api/learning-insights — live mistake-learner output for UI */
export async function GET(req: NextRequest) {
  try {
    const proxied = await proxyToUpstream("/api/learning-insights");
    if (proxied && proxied.ok) {
      const text = await proxied.text();
      if (text.startsWith("{")) {
        lastGood = { text, at: Date.now() };
        const toStash = new Response(text, {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
        const teed = await stashEdgeLastGood(
          EDGE_LEARNING_INSIGHTS_CACHE_URL,
          toStash,
          21600
        );
        try {
          await teed.arrayBuffer();
        } catch {
          /* ignore */
        }
      }
      return withCors(
        req,
        new NextResponse(text, {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          },
        })
      );
    }
    if (proxied) {
      try {
        await proxied.body?.cancel();
      } catch {
        /* ignore */
      }
    }

    if (await isCloudflareWorkersRuntime()) {
      const edge = await matchEdgeLastGood(
        EDGE_LEARNING_INSIGHTS_CACHE_URL,
        "X-Learning-Insights-Stale"
      );
      if (edge) return withCors(req, edge);
      if (lastGood && Date.now() - lastGood.at < LAST_GOOD_MAX_AGE_MS) {
        return withCors(
          req,
          new NextResponse(lastGood.text, {
            status: 200,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-store",
              "X-Learning-Insights-Stale": "1",
            },
          })
        );
      }
      return withCors(
        req,
        NextResponse.json(emptyInsights("BOT_UPSTREAM unavailable; insights live on bot disk"), {
          status: 200,
          headers: { "Cache-Control": "no-store" },
        })
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
    if (lastGood) {
      return withCors(
        req,
        new NextResponse(lastGood.text, {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "X-Learning-Insights-Stale": "1",
          },
        })
      );
    }
    return withCors(
      req,
      NextResponse.json({ error: String(e), ...emptyInsights(String(e)) }, { status: 200 })
    );
  }
}
