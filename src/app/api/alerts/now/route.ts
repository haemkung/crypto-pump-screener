import { proxyToUpstream } from "@/lib/upstreamProxy";
import { NextRequest, NextResponse } from "next/server";
import type { NowAlertsResponse } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALERTS_TTL_MS = 35_000;

/**
 * NOW alerts only — for Telegram / routine consumers.
 * Long and Short lists are separate. Brief cache ~35s.
 * Includes qualityGrade, mtfAlign, regime.
 */
export async function GET(req: NextRequest) {
  try {
    const proxied = await proxyToUpstream(`/api/alerts/now${req.nextUrl.search}`);
    if (proxied) return proxied;
    const [{ buildScreen }, { cacheGet, cacheSet }, { sortNowRows, toNowAlertRow }] =
      await Promise.all([
        import("@/lib/screen"),
        import("@/lib/cache"),
        import("@/lib/urgency"),
      ]);
    const force = req.nextUrl.searchParams.get("refresh") === "1";
    const cacheKey = "alerts:now:v4";

    if (!force) {
      const hit = cacheGet<NowAlertsResponse>(cacheKey);
      if (hit) return NextResponse.json(hit);
    }

    const screen = await buildScreen({ oiTopN: 0, forceRefresh: force });

    const longRaw = screen.rows.filter(
      (r) => r.urgency === "now_long" && r.sweepConfirmed === true
    );
    const shortRaw = screen.rows.filter(
      (r) => r.urgency === "now_short" && r.sweepConfirmed === true
    );

    const long = sortNowRows(longRaw, "long").map(toNowAlertRow);
    const short = sortNowRows(shortRaw, "short").map(toNowAlertRow);
    const waitingLong = sortNowRows(
      screen.rows.filter((r) => r.urgency === "wait_sweep_long"),
      "long"
    )
      .slice(0, 3)
      .map(toNowAlertRow);
    const waitingShort = sortNowRows(
      screen.rows.filter((r) => r.urgency === "wait_sweep_short"),
      "short"
    )
      .slice(0, 3)
      .map(toNowAlertRow);

    const payload: NowAlertsResponse = {
      updatedAt: screen.updatedAt,
      cacheTtlSec: Math.round(ALERTS_TTL_MS / 1000),
      disclaimerTh:
        "เข้าตอนนี้ เป็น heuristic จากแพทเทิร์น ไม่ใช่คำสั่งซื้อ/ขาย และไม่ใช่คำแนะนำการลงทุน",
      regime: screen.meta.regime,
      long,
      short,
      waitingLong,
      waitingShort,
    };

    cacheSet(cacheKey, payload, ALERTS_TTL_MS);
    return NextResponse.json(payload);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
