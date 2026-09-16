import { NextRequest, NextResponse } from "next/server";
import { buildScreen } from "@/lib/screen";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Fast path by default: oiTop=0 (no OI batch) so first paint is snappy.
 * Enrich later with ?oi=1 (alias oiTop=40) or ?oiTop=N.
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const force = searchParams.get("refresh") === "1";

    let oiTop = 0;
    if (searchParams.has("oiTop")) {
      oiTop = Number(searchParams.get("oiTop"));
    } else if (searchParams.get("oi") === "1") {
      oiTop = 40;
    }

    const data = await buildScreen({
      forceRefresh: force,
      oiTopN: Number.isFinite(oiTop) ? Math.min(Math.max(oiTop, 0), 80) : 0,
    });
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { error: String(e) },
      { status: 502 }
    );
  }
}
