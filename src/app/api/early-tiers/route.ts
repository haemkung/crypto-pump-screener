import { proxyToUpstream, isCloudflareWorkersRuntime } from "@/lib/upstreamProxy";
import { withCors, corsPreflight } from "@/lib/cors";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Last good upstream body (isolate memory). Small JSON (<100KB) so holding the text is CPU/memory safe. */
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
 * GET /api/early-tiers — confluence-first early tiers (watch + ignition) from the local daemon.
 * Workers: pass-through to BOT_UPSTREAM (small JSON). Never computes anything. If upstream is down,
 * serves the last good snapshot (its own updatedAt tells the UI how old it is) with X-Early-Tiers-Stale: 1.
 * Soft-fail returns HTTP 200 (not 503).
 */
export async function GET(req: NextRequest) {
  try {
    const proxied = await proxyToUpstream(`/api/early-tiers`, {
      timeoutMs: 15_000,
      retries: 2,
    });
    if (proxied && proxied.ok) {
      const len = Number(proxied.headers.get("content-length") || 0);
      if (len > MAX_BODY_BYTES) return withCors(req, proxied);
      const text = await proxied.text();
      if (text.length <= MAX_BODY_BYTES && text.startsWith("{")) lastGood = { text, at: Date.now() };
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
      if (lastGood && Date.now() - lastGood.at < LAST_GOOD_MAX_AGE_MS) {
        return jsonText(req, lastGood.text, {
          "X-Early-Tiers-Stale": "1",
          "X-Early-Tiers-Cached-At": new Date(lastGood.at).toISOString(),
        });
      }
      return withCors(
        req,
        NextResponse.json(
          {
            updatedAt: null,
            watch: [],
            ignition: [],
            meta: { softFail: true, reason: "BOT_UPSTREAM unavailable" },
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
    return withCors(
      req,
      NextResponse.json(
        { updatedAt: null, watch: [], ignition: [], error: String(e) },
        { status: 500 }
      )
    );
  }
}
