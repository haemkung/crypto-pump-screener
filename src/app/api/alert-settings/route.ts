import { NextResponse } from "next/server";
import {
  readAlertSettings,
  writeAlertSettings,
  defaultAlertSettings,
} from "@/lib/alertSettings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET current Telegram alert mode (creates sharp defaults if missing). */
export async function GET() {
  try {
    const settings = readAlertSettings(true);
    const defaults = defaultAlertSettings();
    return NextResponse.json({
      ...settings,
      defaults: {
        mode: defaults.mode,
        minLongScore: defaults.minLongScore,
        minShortScore: defaults.minShortScore,
        poorWrSkipBelow: defaults.poorWrSkipBelow,
      },
      labelsTh: {
        all: "ส่งทั้งหมด",
        sharp: "เฉพาะสัญญาณคม",
      },
      disclaimerTh:
        "โหมดคม = กรอง Telegram ให้เหลือเฉพาะคะแนนสูง / urgency แรง — ไม่ใช่คำแนะนำการลงทุน",
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/** POST { mode: 'all'|'sharp', minLongScore?, minShortScore?, poorWrSkipBelow? } */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
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
    if (Object.keys(patch).length === 0) {
      return NextResponse.json(
        { error: "Provide mode and/or score thresholds" },
        { status: 400 }
      );
    }
    const settings = writeAlertSettings(patch);
    return NextResponse.json({ ok: true, ...settings });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
