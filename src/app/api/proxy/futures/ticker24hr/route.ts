import { NextRequest } from "next/server";
import { proxyToUpstream } from "@/lib/upstreamProxy";
import { proxyGet, FAPI_HOSTS } from "@/lib/proxyFetch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  {
    const url = new URL(req.url);
    const proxied = await proxyToUpstream(`${url.pathname}${url.search}`);
    if (proxied) return proxied;
  }
  return proxyGet("/fapi/v1/ticker/24hr", FAPI_HOSTS);
}
