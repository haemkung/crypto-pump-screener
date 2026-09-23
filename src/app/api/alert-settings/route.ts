import { proxyToUpstream } from "@/lib/upstreamProxy";
import { NextRequest, NextResponse } from "next/server";
import { withCors, corsPreflight } from "@/lib/cors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function OPTIONS(req: NextRequest) {
  return corsPreflight(req) || new NextResponse(null, { status: 204 });
}

/** GET current Telegram alert mode (creates sharp defaults if missing). */
export async function GET(req: NextRequest) {
  try {
    const proxied = await proxyToUpstream("/api/alert-settings");
    if (proxied) return withCors(req, proxied);
    const { readAlertSettings, defaultAlertSettings } = await import(
      "@/lib/alertSettings"
    );
    const settings = readAlertSettings(true);
    const defaults = defaultAlertSettings();
    return withCors(
      req,
      NextResponse.json({
        ...settings,
        defaults: {
          mode: defaults.mode,
          minLongScore: defaults.minLongScore,
          minShortScore: defaults.minShortScore,
          poorWrSkipBelow: defaults.poorWrSkipBelow,
          minGrade: defaults.minGrade,
        },
        labelsTh: {
          all: "ส่งทั้งหมด",
          sharp: "เฉพาะสัญญาณคม",
        },
        disclaimerTh:
          "โหมดคม = กรอง Telegram ให้เหลือเกรด A (และ B แรง) — ไม่ใช่คำแนะนำการลงทุน",
      })
    );
  } catch (e) {
    return withCors(
      req,
      NextResponse.json({ error: String(e) }, { status: 500 })
    );
  }
}

/** POST { mode, minLongScore?, minShortScore?, poorWrSkipBelow?, minGrade? } */
export async function POST(req: NextRequest) {
  try {
    const raw = await req.text();
    const proxied = await proxyToUpstream("/api/alert-settings", {
      method: "POST",
      body: raw,
      contentType: req.headers.get("content-type") || "application/json",
    });
    if (proxied) return withCors(req, proxied);

    const { writeAlertSettings } = await import("@/lib/alertSettings");
    const body = raw ? JSON.parse(raw) : {};
    const patch: Parameters<typeof writeAlertSettings>[0] = {};
    if (body?.mode === "all" || body?.mode === "sharp") {
      patch.mode = body.mode;
    }
    if (typeof body?.minLongScore === "number") {
      patch.minLongScore = body.minLongScore;
    }
    if (typeof body?.minShortScore === "number") {
      patch.minShortScore = body.minShortScore;
    }
    if (typeof body?.poorWrSkipBelow === "number") {
      patch.poorWrSkipBelow = body.poorWrSkipBelow;
    }
    if (body?.minGrade === "A" || body?.minGrade === "B" || body?.minGrade === "C") {
      patch.minGrade = body.minGrade;
    }
    if (Object.keys(patch).length === 0) {
      return withCors(
        req,
        NextResponse.json(
          { error: "Provide mode and/or score thresholds / minGrade" },
          { status: 400 }
        )
      );
    }
    const settings = writeAlertSettings(patch);
    return withCors(req, NextResponse.json({ ok: true, ...settings }));
  } catch (e) {
    return withCors(
      req,
      NextResponse.json({ error: String(e) }, { status: 500 })
    );
  }
}
