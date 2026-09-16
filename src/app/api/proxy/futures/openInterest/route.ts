import { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { proxyGet, FAPI_HOSTS } from "@/lib/proxyFetch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol");
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  return proxyGet(`/fapi/v1/openInterest?symbol=${encodeURIComponent(symbol)}`, FAPI_HOSTS);
}
