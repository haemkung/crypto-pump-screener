import { NextRequest, NextResponse } from "next/server";
import { proxyGet, FAPI_HOSTS } from "@/lib/proxyFetch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const symbol = sp.get("symbol");
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  const period = sp.get("period") || "1h";
  const limit = sp.get("limit") || "12";
  return proxyGet(
    `/futures/data/openInterestHist?symbol=${encodeURIComponent(symbol)}&period=${encodeURIComponent(period)}&limit=${encodeURIComponent(limit)}`,
    FAPI_HOSTS
  );
}
