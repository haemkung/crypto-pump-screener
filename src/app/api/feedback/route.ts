import { proxyToUpstream } from "@/lib/upstreamProxy";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST { symbol, side: 'long'|'short', outcome: 'win'|'loss', note? }
 * Manual ถูก/ผิด feedback → alert-log + learned-cases + refresh weights.
 * On Workers, proxy to UPSTREAM so Learn buttons write bot data/*.json.
 */
export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const proxied = await proxyToUpstream("/api/feedback", {
      method: "POST",
      body: raw,
      contentType: req.headers.get("content-type") || "application/json",
    });
    if (proxied) return proxied;

    const { applyManualFeedback } = await import("@/lib/learningStore");
    const body = raw ? JSON.parse(raw) : {};
    const symbol = String(body?.symbol || "").trim();
    const side = body?.side === "short" ? "short" : body?.side === "long" ? "long" : null;
    const outcome =
      body?.outcome === "win" || body?.outcome === "loss" ? body.outcome : null;
    const note = typeof body?.note === "string" ? body.note : undefined;
    const movePct =
      typeof body?.movePct === "number" ? body.movePct : undefined;
    const score = typeof body?.score === "number" ? body.score : undefined;
    const price = typeof body?.price === "number" ? body.price : undefined;

    if (!symbol || !side || !outcome) {
      return NextResponse.json(
        {
          error:
            "Required: symbol, side ('long'|'short'), outcome ('win'|'loss')",
        },
        { status: 400 }
      );
    }

    const result = applyManualFeedback({
      symbol,
      side,
      outcome,
      note,
      movePct,
      score,
      price,
    });

    return NextResponse.json({
      ok: true,
      ...result,
      disclaimerTh:
        "ฟีดแบ็กมือเป็น heuristic สำหรับเรียนรู้ — ไม่ใช่ผลตอบแทนจริง และไม่ใช่คำแนะนำการลงทุน",
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
