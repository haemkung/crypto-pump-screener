import { NextRequest, NextResponse } from "next/server";
import { readCoachNotes } from "@/lib/coachNotes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/coach-notes?limit=12 — last N Thai post-trade coach notes */
export async function GET(req: NextRequest) {
  try {
    const limit = Math.min(
      50,
      Math.max(1, Number(req.nextUrl.searchParams.get("limit") || 12) || 12)
    );
    const file = readCoachNotes();
    const notes = [...file.notes].reverse().slice(0, limit);
    return NextResponse.json({
      notes,
      total: file.notes.length,
      disclaimerTh:
        "โน้ตโค้ชเป็น heuristic หลังเกรด — ไม่ใช่คำแนะนำการลงทุน",
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
