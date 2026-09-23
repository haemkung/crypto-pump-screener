import { proxyToUpstream } from "@/lib/upstreamProxy";
import { NextRequest, NextResponse } from "next/server";
import { withCors, corsPreflight } from "@/lib/cors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Graded alert outcomes for UI "เคสที่ระบบเรียนรู้".
 * Newest first; caps at 60 for payload size.
 */
export async function OPTIONS(req: NextRequest) {
  return corsPreflight(req) || new NextResponse(null, { status: 204 });
}

export async function GET(req: NextRequest) {
  try {
    const proxied = await proxyToUpstream("/api/learned-cases");
    if (proxied) return withCors(req, proxied);
    const { readLearnedCases } = await import("@/lib/learnedCases");
    const all = readLearnedCases();
    const cases = [...all]
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
      .slice(0, 60);
    return withCors(
      req,
      NextResponse.json({
        updatedAt: new Date().toISOString(),
        count: cases.length,
        total: all.length,
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
