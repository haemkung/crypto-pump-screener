import { NextRequest } from "next/server";
import { proxyToUpstream } from "@/lib/upstreamProxy";
import { proxyGet, SPOT_HOSTS } from "@/lib/proxyFetch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  {
    const url = new URL(req.url);
    const proxied = await proxyToUpstream(`${url.pathname}${url.search}`);
    if (proxied) return proxied;
  }
  return proxyGet("/api/v3/ticker/24hr", SPOT_HOSTS);
}
