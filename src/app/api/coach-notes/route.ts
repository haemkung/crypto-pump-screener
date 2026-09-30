import { proxyToUpstream, isCloudflareWorkersRuntime } from "@/lib/upstreamProxy";
import { NextRequest, NextResponse } from "next/server";
import { withCors, corsPreflight } from "@/lib/cors";
import {
  EDGE_COACH_NOTES_CACHE_URL,
  stashEdgeLastGood,
  matchEdgeLastGood,
} from "@/lib/edgeLastGood";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let lastGood: { text: string; at: number } | null = null;
const LAST_GOOD_MAX_AGE_MS = 24 * 3600e3;

export async function OPTIONS(req: NextRequest) {
  return corsPreflight(req) || new NextResponse(null, { status: 204 });
}

function emptyCoach(reason: string, limit = 12) {
  return {
    notes: [],
    total: 0,
    limit,
    meta: { softFail: true, reason },
    noteTh: "ข้อมูลค้าง — ยังไม่มีโน้ตโค้ชล่าสุด",
    disclaimerTh: "โน้ตโค้ชเป็น heuristic หลังเกรด — ไม่ใช่คำแนะนำการลงทุน",
  };
}

function parseLimit(req: NextRequest): number {
  return Math.min(
    50,
    Math.max(1, Number(req.nextUrl.searchParams.get("limit") || 12) || 12)
  );
}

/** GET /api/coach-notes?limit=12 — last N Thai post-trade coach notes */
export async function GET(req: NextRequest) {
  const limit = parseLimit(req);
  try {
    const proxied = await proxyToUpstream(
      `/api/coach-notes${req.nextUrl.search}`
    );
    if (proxied && proxied.ok) {
      const text = await proxied.text();
      if (text.startsWith("{")) {
        lastGood = { text, at: Date.now() };
        const toStash = new Response(text, {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
        const teed = await stashEdgeLastGood(
          EDGE_COACH_NOTES_CACHE_URL,
          toStash,
          21600
        );
        try {
          await teed.arrayBuffer();
        } catch {
          /* ignore */
        }
      }
      return withCors(
        req,
        new NextResponse(text, {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          },
        })
      );
    }
    if (proxied) {
      try {
        await proxied.body?.cancel();
      } catch {
        /* ignore */
      }
    }

    // Workers: never touch node:fs (unenv mkdirSync → HTTP 500 → UI "โหลดไม่สำเร็จ")
    if (await isCloudflareWorkersRuntime()) {
      const edge = await matchEdgeLastGood(
        EDGE_COACH_NOTES_CACHE_URL,
        "X-Coach-Notes-Stale"
      );
      if (edge) return withCors(req, edge);
      if (lastGood && Date.now() - lastGood.at < LAST_GOOD_MAX_AGE_MS) {
        return withCors(
          req,
          new NextResponse(lastGood.text, {
            status: 200,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-store",
              "X-Coach-Notes-Stale": "1",
            },
          })
        );
      }
      return withCors(
        req,
        NextResponse.json(
          emptyCoach("BOT_UPSTREAM unavailable; coach notes live on bot disk", limit),
          { status: 200, headers: { "Cache-Control": "no-store" } }
        )
      );
    }

    const { readCoachNotes } = await import("@/lib/coachNotes");
    const file = readCoachNotes();
    const notes = [...file.notes].reverse().slice(0, limit);
    return withCors(
      req,
      NextResponse.json({
        notes,
        total: file.notes.length,
        disclaimerTh:
          "โน้ตโค้ชเป็น heuristic หลังเกรด — ไม่ใช่คำแนะนำการลงทุน",
      })
    );
  } catch (e) {
    if (lastGood) {
      return withCors(
        req,
        new NextResponse(lastGood.text, {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "X-Coach-Notes-Stale": "1",
          },
        })
      );
    }
    return withCors(
      req,
      NextResponse.json(
        { error: String(e), ...emptyCoach(String(e), limit) },
        { status: 200 }
      )
    );
  }
}
