import { proxyToUpstream } from "@/lib/upstreamProxy";
import { NextRequest, NextResponse } from "next/server";
import { withCors, corsPreflight } from "@/lib/cors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function OPTIONS(req: NextRequest) {
  return corsPreflight(req) || new NextResponse(null, { status: 204 });
}

/**
 * POST { symbol, side: 'long'|'short', outcome: 'win'|'loss', note? }
 * Manual ถูก/ผิด feedback → alert-log + learned-cases + refresh weights.
 * On Workers, proxy to UPSTREAM so Learn buttons write bot data/*.json.
 */
export async function POST(req: NextRequest) {
  try {
    const raw = await req.text();
    const proxied = await proxyToUpstream("/api/feedback", {
      method: "POST",
      body: raw,
      contentType: req.headers.get("content-type") || "application/json",
    });
    if (proxied) return withCors(req, proxied);

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
      return withCors(
        req,
        NextResponse.json(
          {
            error:
              "Required: symbol, side ('long'|'short'), outcome ('win'|'loss')",
          },
          { status: 400 }
        )
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

    return withCors(
      req,
      NextResponse.json({
        ok: true,
        ...result,
        disclaimerTh:
          "ฟีดแบ็กมือเป็น heuristic สำหรับเรียนรู้ — ไม่ใช่ผลตอบแทนจริง และไม่ใช่คำแนะนำการลงทุน",
      })
    );
  } catch (e) {
    return withCors(
      req,
      NextResponse.json({ error: String(e) }, { status: 500 })
    );
  }
}
