import { NextRequest, NextResponse } from "next/server";
import { buildScreen } from "@/lib/screen";
import { cacheGet, cacheSet } from "@/lib/cache";
import { sortNowRows, toNowAlertRow } from "@/lib/urgency";
import type { NowAlertsResponse } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALERTS_TTL_MS = 35_000;

/**
 * NOW alerts only — for Telegram / routine consumers.
 * Long and Short lists are separate. Brief cache ~35s.
 */
export async function GET(req: NextRequest) {
  try {
    const force = req.nextUrl.searchParams.get("refresh") === "1";
    const cacheKey = "alerts:now:v1";

    if (!force) {
      const hit = cacheGet<NowAlertsResponse>(cacheKey);
      if (hit) return NextResponse.json(hit);
    }

    // Reuse screen build (fast path oiTop=0); urgency already on each row
    const screen = await buildScreen({ oiTopN: 0, forceRefresh: force });

    const longRaw = screen.rows.filter((r) => r.urgency === "now_long");
    const shortRaw = screen.rows.filter((r) => r.urgency === "now_short");

    const long = sortNowRows(longRaw, "long").map(toNowAlertRow);
    const short = sortNowRows(shortRaw, "short").map(toNowAlertRow);

    const payload: NowAlertsResponse = {
      updatedAt: screen.updatedAt,
      cacheTtlSec: Math.round(ALERTS_TTL_MS / 1000),
      disclaimerTh:
        "เข้าตอนนี้ เป็น heuristic จากแพทเทิร์น ไม่ใช่คำสั่งซื้อ/ขาย และไม่ใช่คำแนะนำการลงทุน",
      long,
      short,
    };

    cacheSet(cacheKey, payload, ALERTS_TTL_MS);
    return NextResponse.json(payload);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
