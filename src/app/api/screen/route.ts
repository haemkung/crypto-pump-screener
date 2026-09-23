import { proxyToUpstream, isCloudflareWorkersRuntime } from "@/lib/upstreamProxy";
import { getLastGood, rememberLastGood } from "@/lib/lastGoodCache";
import { withCors, corsPreflight } from "@/lib/cors";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LAST_GOOD_KEY = "screen:last-good-v1";

/**
 * Fast path by default: oiTop=0 (no OI batch) so first paint is snappy.
 * Enrich later with ?oi=1 (alias oiTop=40) or ?oiTop=N.
 * On Workers, always prefer BOT_UPSTREAM — never buffer/parse the ~1.5MB body
 * (Error 1102). Skip heavy buildScreen on Workers; soft-fail with last-good.
 */
export async function OPTIONS(req: NextRequest) {
  return corsPreflight(req) || new NextResponse(null, { status: 204 });
}

export async function GET(req: NextRequest) {
  try {
    const proxied = await proxyToUpstream(`/api/screen${req.nextUrl.search}`);
    if (proxied) {
      // Do NOT clone().json() — screen payload ~1.5MB blows Workers CPU/memory.
      return withCors(req, proxied);
    }

    // Workers must not run buildScreen (CPU → Error 1102). Soft-fail instead.
    if (await isCloudflareWorkersRuntime()) {
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
            updatedAt: new Date().toISOString(),
            cacheTtlSec: 45,
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
