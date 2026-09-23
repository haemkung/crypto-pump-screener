import { proxyToUpstream } from "@/lib/upstreamProxy";
import { NextRequest, NextResponse } from "next/server";
import type { KlineInterval } from "@/lib/binance";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOWED: KlineInterval[] = ["5m", "15m", "1h", "4h", "1d"];

/** GET /api/klines?symbol=BTCUSDT&interval=15m&limit=48 — cached server-side */
export async function GET(req: NextRequest) {
  try {
    const proxied = await proxyToUpstream(`/api/klines${req.nextUrl.search}`);
    if (proxied) return proxied;

    const { getKlines } = await import("@/lib/binance");
    const symbol = (req.nextUrl.searchParams.get("symbol") || "").toUpperCase();
    if (!symbol || !symbol.endsWith("USDT") || symbol.includes("_")) {
      return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
    }
    const intervalRaw = (req.nextUrl.searchParams.get("interval") ||
      "15m") as KlineInterval;
    const interval = ALLOWED.includes(intervalRaw) ? intervalRaw : "15m";
    const limit = Math.min(
      200,
      Math.max(5, Number(req.nextUrl.searchParams.get("limit") || 48) || 48)
    );
    const bars = await getKlines(symbol, interval, limit);
    return NextResponse.json({
      symbol,
      interval,
      limit,
      closes: bars.map((b) => b.close),
      bars: bars.map((b) => ({
        t: b.openTime,
        o: b.open,
        h: b.high,
        l: b.low,
        c: b.close,
        v: b.volume,
      })),
      cacheHintSec: 60,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
