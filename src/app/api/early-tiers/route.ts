import { proxyToUpstream, isCloudflareWorkersRuntime } from "@/lib/upstreamProxy";
import { withCors, corsPreflight } from "@/lib/cors";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function OPTIONS(req: NextRequest) {
  return corsPreflight(req) || new NextResponse(null, { status: 204 });
}

/**
 * GET /api/early-tiers — confluence-first early tiers (watch + ignition) from the local daemon.
 * Workers: pass-through to BOT_UPSTREAM (small JSON, streamed). Never computes anything.
 */
export async function GET(req: NextRequest) {
  try {
    const proxied = await proxyToUpstream(`/api/early-tiers`);
    if (proxied) return withCors(req, proxied);
    if (await isCloudflareWorkersRuntime()) {
      return withCors(
        req,
        NextResponse.json(
          { updatedAt: null, watch: [], ignition: [], meta: { softFail: true, reason: "BOT_UPSTREAM unavailable" } },
          { status: 503, headers: { "Cache-Control": "no-store" } }
        )
      );
    }
    const { readEarlyTiers } = await import("@/lib/earlyTiers");
    return withCors(req, NextResponse.json(readEarlyTiers(), { headers: { "Cache-Control": "no-store" } }));
  } catch (e) {
    return withCors(req, NextResponse.json({ updatedAt: null, watch: [], ignition: [], error: String(e) }, { status: 500 }));
  }
}
