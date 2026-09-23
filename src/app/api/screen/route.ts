import { proxyToUpstream } from "@/lib/upstreamProxy";
import { getLastGood, rememberLastGood } from "@/lib/lastGoodCache";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LAST_GOOD_KEY = "screen:last-good-v1";

/**
 * Fast path by default: oiTop=0 (no OI batch) so first paint is snappy.
 * Enrich later with ?oi=1 (alias oiTop=40) or ?oiTop=N.
 * On Workers, always prefer BOT_UPSTREAM — lazy-import buildScreen only as local fallback
 * so cold starts do not parse the heavy screener graph when VPC is bound.
 * If both upstream and local fail, briefly serve last good real payload (no invented rows).
 */
export async function GET(req: NextRequest) {
  try {
    const proxied = await proxyToUpstream(`/api/screen${req.nextUrl.search}`);
    if (proxied) {
      if (proxied.ok) {
        try {
          const clone = proxied.clone();
          const data = await clone.json();
          rememberLastGood(LAST_GOOD_KEY, data);
        } catch {
          // non-JSON — ignore
        }
      }
      return proxied;
    }
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
            "X-Screen-Stale": "1",
            "Cache-Control": "no-store",
          },
        }
      );
    }
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
