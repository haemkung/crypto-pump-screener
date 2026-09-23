import { proxyToUpstream, isCloudflareWorkersRuntime } from "@/lib/upstreamProxy";
import { getLastGood, rememberLastGood } from "@/lib/lastGoodCache";
import { withCors, corsPreflight } from "@/lib/cors";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LAST_GOOD_KEY = "hot:last-good-v1";

/**
 * GET /api/hot — top early accelerators (pct1h + early-band 24h).
 * On Workers, prefer BOT_UPSTREAM; do not re-parse proxied body for cache.
 */
export async function OPTIONS(req: NextRequest) {
  return corsPreflight(req) || new NextResponse(null, { status: 204 });
}

export async function GET(req: NextRequest) {
  try {
    const proxied = await proxyToUpstream(`/api/hot${req.nextUrl.search}`);
    if (proxied) {
      return withCors(req, proxied);
    }

    if (await isCloudflareWorkersRuntime()) {
      const stale = getLastGood<Record<string, unknown>>(LAST_GOOD_KEY);
      if (stale && Array.isArray((stale as { hot?: unknown }).hot)) {
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
                "X-Hot-Stale": "1",
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
            updatedAt: new Date().toISOString(),
            cacheTtlSec: 35,
            hot: [],
            meta: { softFail: true, reason: "BOT_UPSTREAM unavailable" },
          },
          { status: 503, headers: { "Cache-Control": "no-store" } }
        )
      );
    }

    const force = req.nextUrl.searchParams.get("refresh") === "1";
    const { buildHot } = await import("@/lib/hot");
    const data = await buildHot({ forceRefresh: force });
    rememberLastGood(LAST_GOOD_KEY, data);
    return withCors(req, NextResponse.json(data));
  } catch (e) {
    const stale = getLastGood<Record<string, unknown>>(LAST_GOOD_KEY);
    if (stale && Array.isArray((stale as { hot?: unknown }).hot)) {
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
              "X-Hot-Stale": "1",
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
