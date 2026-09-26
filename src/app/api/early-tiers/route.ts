import { proxyToUpstream, isCloudflareWorkersRuntime } from "@/lib/upstreamProxy";
import { withCors, corsPreflight } from "@/lib/cors";
import {
  EDGE_EARLY_TIERS_CACHE_URL,
  stashEdgeLastGood,
  matchEdgeLastGood,
} from "@/lib/edgeLastGood";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Isolate-memory last-good (complements Cache API for same-isolate hits). */
let lastGood: { text: string; at: number } | null = null;
const LAST_GOOD_MAX_AGE_MS = 24 * 3600e3;
const MAX_BODY_BYTES = 400_000;

export async function OPTIONS(req: NextRequest) {
  return corsPreflight(req) || new NextResponse(null, { status: 204 });
}

function jsonText(req: NextRequest, text: string, extra: Record<string, string> = {}) {
  return withCors(
    req,
    new NextResponse(text, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...extra,
      },
    })
  );
}

/**
 * GET /api/early-tiers — confluence-first early tiers from the local daemon.
 * Workers: proxy BOT_UPSTREAM, stash into Cache API last-good. On upstream miss,
 * serve edge/in-memory last-good with X-Early-Tiers-Stale:1 (HTTP 200). Soft-fail
 * empty only when no last-good exists — never hard-blank the SPA.
 */
function wantsFresh(req: NextRequest): boolean {
  const sp = req.nextUrl.searchParams;
  if (sp.has("t") || sp.get("fresh") === "1" || sp.get("bypassCache") === "1") {
    return true;
  }
  const cc = (req.headers.get("cache-control") || "").toLowerCase();
  return cc.includes("no-cache") || cc.includes("no-store");
}

export async function GET(req: NextRequest) {
  try {
    const fresh = wantsFresh(req);
    const proxied = await proxyToUpstream(`/api/early-tiers`, {
      timeoutMs: 15_000,
      retries: 2,
    });
    if (proxied && proxied.ok) {
      const len = Number(proxied.headers.get("content-length") || 0);
      if (len > MAX_BODY_BYTES) return withCors(req, proxied);
      const text = await proxied.text();
      if (text.length <= MAX_BODY_BYTES && text.startsWith("{")) {
        lastGood = { text, at: Date.now() };
        // Small JSON: buffer+stash is safe (unlike multi-MB /api/screen).
        const toStash = new Response(text, {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
        const teed = await stashEdgeLastGood(
          EDGE_EARLY_TIERS_CACHE_URL,
          toStash,
          900
        );
        // Drain client tee branch so the cache put can finish.
        try {
          await teed.arrayBuffer();
        } catch {
          /* ignore */
        }
      }
      return jsonText(req, text);
    }
    if (proxied) {
      try {
        await proxied.body?.cancel();
      } catch {
        /* ignore */
      }
    }
    if (await isCloudflareWorkersRuntime()) {
      // Manual refresh (?t=) skips sticky last-good so UI does not keep showing hours-old data
      // when upstream is briefly unavailable — soft-fail instead.
      if (!fresh) {
        const edge = await matchEdgeLastGood(
          EDGE_EARLY_TIERS_CACHE_URL,
          "X-Early-Tiers-Stale"
        );
        if (edge) return withCors(req, edge);

        if (lastGood && Date.now() - lastGood.at < LAST_GOOD_MAX_AGE_MS) {
          return jsonText(req, lastGood.text, {
            "X-Early-Tiers-Stale": "1",
            "X-Early-Tiers-Cached-At": new Date(lastGood.at).toISOString(),
          });
        }
      }
      return withCors(
        req,
        NextResponse.json(
          {
            updatedAt: null,
            watch: [],
            ignition: [],
            meta: { softFail: true, reason: "BOT_UPSTREAM unavailable" },
            noteTh: "ข้อมูลค้าง — upstream ยังไม่พร้อม และยังไม่มี last-good",
          },
          {
            status: 200,
            headers: {
              "X-Early-Tiers-Soft-Fail": "1",
              "Cache-Control": "no-store",
            },
          }
        )
      );
    }
    const { readEarlyTiers } = await import("@/lib/earlyTiers");
    return withCors(
      req,
      NextResponse.json(readEarlyTiers(), { headers: { "Cache-Control": "no-store" } })
    );
  } catch (e) {
    if (lastGood) return jsonText(req, lastGood.text, { "X-Early-Tiers-Stale": "1" });
    try {
      const edge = await matchEdgeLastGood(
        EDGE_EARLY_TIERS_CACHE_URL,
        "X-Early-Tiers-Stale"
      );
      if (edge) return withCors(req, edge);
    } catch {
      /* ignore */
    }
    return withCors(
      req,
      NextResponse.json(
        {
          updatedAt: null,
          watch: [],
          ignition: [],
          error: String(e),
          noteTh: "ข้อมูลค้าง",
        },
        { status: 200 }
      )
    );
  }
}
