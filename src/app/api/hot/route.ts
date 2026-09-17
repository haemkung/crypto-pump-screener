import { proxyToUpstream } from "@/lib/upstreamProxy";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/hot — top early accelerators (pct1h + early-band 24h).
 * On Workers, prefer BOT_UPSTREAM so kline enrichment stays on the bot.
 */
export async function GET(req: NextRequest) {
  try {
    const proxied = await proxyToUpstream(`/api/hot${req.nextUrl.search}`);
    if (proxied) return proxied;

    const force = req.nextUrl.searchParams.get("refresh") === "1";
    const { buildHot } = await import("@/lib/hot");
    const data = await buildHot({ forceRefresh: force });
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
