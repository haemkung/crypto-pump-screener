import { proxyToUpstream, isCloudflareWorkersRuntime } from "@/lib/upstreamProxy";
import { getLastGood, rememberLastGood } from "@/lib/lastGoodCache";
import {
  EDGE_SCREEN_CACHE_URL,
  stashEdgeLastGood,
  matchEdgeLastGood,
} from "@/lib/edgeLastGood";
import { withCors, corsPreflight } from "@/lib/cors";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LAST_GOOD_KEY = "screen:last-good-v1";

/**
 * Fast path by default: oiTop=0 (no OI batch) so first paint is snappy.
 * Enrich later with ?oi=1 (alias oiTop=40) or ?oiTop=N.
 *
 * Workers: prefer BOT_UPSTREAM, tee successful bodies into Cache API last-good
 * (no JSON.parse of the ~1.5MB payload — avoids Error 1102). On upstream miss,
 * serve Cache API / in-memory last-good with X-Screen-Stale:1. Only 503 when
 * both upstream and last-good miss.
 */
export async function OPTIONS(req: NextRequest) {
  return corsPreflight(req) || new NextResponse(null, { status: 204 });
}

export async function GET(req: NextRequest) {
  try {
    const proxied = await proxyToUpstream(`/api/screen${req.nextUrl.search}`, {
      timeoutMs: 28_000,
      retries: 2,
    });
    if (proxied) {
      // Tee into Cache API; stream client branch — never buffer+parse.
      const out = await stashEdgeLastGood(EDGE_SCREEN_CACHE_URL, proxied, 3600);
      return withCors(req, out);
    }

    if (await isCloudflareWorkersRuntime()) {
      const edge = await matchEdgeLastGood(
        EDGE_SCREEN_CACHE_URL,
        "X-Screen-Stale"
      );
      if (edge) return withCors(req, edge);

      const stale = getLastGood<Record<string, unknown>>(LAST_GOOD_KEY);
      if (stale && Array.isArray(stale.rows) && stale.rows.length > 0) {
        return withCors(
          req,
          NextResponse.json(
            {
              ...stale,
              meta: {
                ...(typeof stale.meta === "object" && stale.meta
                  ? (stale.meta as object)
                  : {}),
                stale: true,
                staleReason: "BOT_UPSTREAM unavailable; serving last-good",
              },
            },
            {
              status: 200,
              headers: {
                "X-Screen-Stale": "1",
                "Cache-Control": "no-store",
              },
            }
          )
        );
      }

      return withCors(
        req,
        NextResponse.json(
          {
            error:
              "BOT_UPSTREAM unavailable and no last-good cache (Workers skip heavy buildScreen)",
            updatedAt: new Date().toISOString(),
            rows: [],
            meta: {
              softFail: true,
              reason:
                "BOT_UPSTREAM unavailable; Workers skip heavy buildScreen (no invented rows)",
            },
          },
          { status: 503, headers: { "Cache-Control": "no-store" } }
        )
      );
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
    return withCors(req, NextResponse.json(data));
  } catch (e) {
    const edge = await matchEdgeLastGood(
      EDGE_SCREEN_CACHE_URL,
      "X-Screen-Stale"
    );
    if (edge) return withCors(req, edge);

    const stale = getLastGood<Record<string, unknown>>(LAST_GOOD_KEY);
    if (stale && Array.isArray(stale.rows) && stale.rows.length > 0) {
      return withCors(
        req,
        NextResponse.json(
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
        )
      );
    }
    return withCors(
      req,
      NextResponse.json({ error: String(e) }, { status: 502 })
    );
  }
}
