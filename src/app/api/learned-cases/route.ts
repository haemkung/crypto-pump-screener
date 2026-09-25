import { proxyToUpstream, isCloudflareWorkersRuntime } from "@/lib/upstreamProxy";
import { NextRequest, NextResponse } from "next/server";
import { withCors, corsPreflight } from "@/lib/cors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Graded alert outcomes for UI "เคสที่ระบบเรียนรู้".
 * Prefer win/loss (what the UI shows) so neutrals do not bury real cases
 * when we cap the payload at ~60.
 */
export async function OPTIONS(req: NextRequest) {
  return corsPreflight(req) || new NextResponse(null, { status: 204 });
}

export async function GET(req: NextRequest) {
  try {
    const proxied = await proxyToUpstream("/api/learned-cases", {
      timeoutMs: 15_000,
      retries: 2,
    });
    if (proxied) return withCors(req, proxied);

    // On Workers with no upstream, local data/*.json is absent — soft-fail
    // instead of looking like "learning never ran".
    if (await isCloudflareWorkersRuntime()) {
      return withCors(
        req,
        NextResponse.json(
          {
            updatedAt: new Date().toISOString(),
            count: 0,
            total: 0,
            cases: [],
            meta: {
              softFail: true,
              reason: "BOT_UPSTREAM unavailable; learned cases live on bot disk",
            },
            disclaimerTh:
              "เคสที่ระบบเรียนรู้จากผล NOW จริง — heuristic ไม่การันตีผลในอนาคต และไม่ใช่คำแนะนำการลงทุน",
          },
          {
            status: 200,
            headers: {
              "X-Learned-Soft-Fail": "1",
              "Cache-Control": "no-store",
            },
          }
        )
      );
    }

    const { readLearnedCases } = await import("@/lib/learnedCases");
    const all = readLearnedCases();
    const byNewest = (a: { timestamp: string }, b: { timestamp: string }) =>
      a.timestamp < b.timestamp ? 1 : -1;
    const graded = all
      .filter((c) => c.outcome === "win" || c.outcome === "loss")
      .sort(byNewest);
    const neutrals = all.filter((c) => c.outcome === "neutral").sort(byNewest);
    // UI shows win/loss first; keep a few neutrals for context. Cap payload.
    const cases = [...graded.slice(0, 48), ...neutrals.slice(0, 12)];
    return withCors(
      req,
      NextResponse.json({
        updatedAt: new Date().toISOString(),
        count: cases.length,
        total: all.length,
        gradedTotal: graded.length,
        disclaimerTh:
          "เคสที่ระบบเรียนรู้จากผล NOW จริง — heuristic ไม่การันตีผลในอนาคต และไม่ใช่คำแนะนำการลงทุน",
        cases,
      })
    );
  } catch (e) {
    return withCors(
      req,
      NextResponse.json({ error: String(e) }, { status: 500 })
    );
  }
}
