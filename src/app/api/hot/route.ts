import { proxyToUpstream } from "@/lib/upstreamProxy";
import { getLastGood, rememberLastGood } from "@/lib/lastGoodCache";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LAST_GOOD_KEY = "hot:last-good-v1";

/**
 * GET /api/hot — top early accelerators (pct1h + early-band 24h).
 * On Workers, prefer BOT_UPSTREAM so kline enrichment stays on the bot.
 */
export async function GET(req: NextRequest) {
  try {
    const proxied = await proxyToUpstream(`/api/hot${req.nextUrl.search}`);
    if (proxied) {
      if (proxied.ok) {
        try {
          const clone = proxied.clone();
          const data = await clone.json();
          rememberLastGood(LAST_GOOD_KEY, data);
        } catch {
          // ignore
        }
      }
      return proxied;
    }

    const force = req.nextUrl.searchParams.get("refresh") === "1";
    const { buildHot } = await import("@/lib/hot");
    const data = await buildHot({ forceRefresh: force });
    rememberLastGood(LAST_GOOD_KEY, data);
    return NextResponse.json(data);
  } catch (e) {
    const stale = getLastGood<Record<string, unknown>>(LAST_GOOD_KEY);
    if (stale && Array.isArray(stale.rows) && stale.rows.length > 0) {
      return NextResponse.json(
        {
          ...stale,
          meta: {
            ...(typeof stale.meta === "object" && stale.meta
              ? (stale.meta as object)
              : {}),
            stale: true,
            staleReason: String(e),
          },
        },
        {
          status: 200,
          headers: {
            "X-Hot-Stale": "1",
            "Cache-Control": "no-store",
          },
        }
      );
    }
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
