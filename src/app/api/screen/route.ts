import { proxyToUpstream } from "@/lib/upstreamProxy";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Fast path by default: oiTop=0 (no OI batch) so first paint is snappy.
 * Enrich later with ?oi=1 (alias oiTop=40) or ?oiTop=N.
 * On Workers, always prefer BOT_UPSTREAM — lazy-import buildScreen only as local fallback
 * so cold starts do not parse the heavy screener graph when VPC is bound.
 */
export async function GET(req: NextRequest) {
  try {
    const proxied = await proxyToUpstream(`/api/screen${req.nextUrl.search}`);
    if (proxied) return proxied;
    const { searchParams } = req.nextUrl;
    const force = searchParams.get("refresh") === "1";

    let oiTop = 0;
    if (searchParams.has("oiTop")) {
      oiTop = Number(searchParams.get("oiTop"));
    } else if (searchParams.get("oi") === "1") {
      oiTop = 40;
    }

    const { buildScreen } = await import("@/lib/screen");
    const data = await buildScreen({
      forceRefresh: force,
      oiTopN: Number.isFinite(oiTop) ? Math.min(Math.max(oiTop, 0), 80) : 0,
    });
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
