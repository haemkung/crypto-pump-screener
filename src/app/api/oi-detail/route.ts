import { proxyToUpstream } from "@/lib/upstreamProxy";
import { NextRequest, NextResponse } from "next/server";
import { withCors, corsPreflight } from "@/lib/cors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function OPTIONS(req: NextRequest) {
  return corsPreflight(req) || new NextResponse(null, { status: 204 });
}

export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get("symbol") || "").toUpperCase();
  if (!symbol || !symbol.endsWith("USDT") || symbol.includes("_")) {
    return withCors(
      req,
      NextResponse.json({ error: "Invalid symbol" }, { status: 400 })
    );
  }

  try {
    const proxied = await proxyToUpstream(`/api/oi-detail${req.nextUrl.search}`);
    if (proxied) return withCors(req, proxied);

    const {
      getOpenInterest,
      getOpenInterestHist,
      getGlobalLongShortAccountRatio,
      getTopLongShortPositionRatio,
      getTakerLongShortRatio,
      isUsdtPerpetual,
    } = await import("@/lib/binance");
    if (!isUsdtPerpetual(symbol)) {
      return withCors(
        req,
        NextResponse.json({ error: "Invalid symbol" }, { status: 400 })
      );
    }

    const [oi, hist, globalLS, topLS, taker] = await Promise.all([
      getOpenInterest(symbol).catch(() => null),
      getOpenInterestHist(symbol, "1h", 12).catch(() => null),
      getGlobalLongShortAccountRatio(symbol).catch(() => null),
      getTopLongShortPositionRatio(symbol).catch(() => null),
      getTakerLongShortRatio(symbol).catch(() => null),
    ]);

    let oiChangePct: number | null = null;
    if (hist && hist.length >= 2) {
      const oldest = Number(hist[0].sumOpenInterest);
      const newest = Number(hist[hist.length - 1].sumOpenInterest);
      if (oldest > 0 && Number.isFinite(oldest) && Number.isFinite(newest)) {
        oiChangePct = ((newest - oldest) / oldest) * 100;
      }
    }

    return withCors(
      req,
      NextResponse.json({
        symbol,
        openInterest: oi,
        openInterestHist: hist,
        oiChangePct,
        globalLongShortAccountRatio: globalLS,
        topLongShortPositionRatio: topLS,
        takerLongShortRatio: taker,
      })
    );
  } catch (e) {
    return withCors(
      req,
      NextResponse.json({ error: String(e) }, { status: 502 })
    );
  }
}
