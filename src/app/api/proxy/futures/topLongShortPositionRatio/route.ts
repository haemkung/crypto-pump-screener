import { proxyToUpstream } from "@/lib/upstreamProxy";
import { NextRequest, NextResponse } from "next/server";
import { proxyGet, FAPI_HOSTS } from "@/lib/proxyFetch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  {
    const proxied = await proxyToUpstream(`${req.nextUrl.pathname}${req.nextUrl.search}`);
    if (proxied) return proxied;
  }
  const sp = req.nextUrl.searchParams;
  const symbol = sp.get("symbol");
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  const period = sp.get("period") || "1h";
  const limit = sp.get("limit") || "1";
  return proxyGet(
    `/futures/data/topLongShortPositionRatio?symbol=${encodeURIComponent(symbol)}&period=${encodeURIComponent(period)}&limit=${encodeURIComponent(limit)}`,
    FAPI_HOSTS
  );
}
