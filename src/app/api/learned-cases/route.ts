import { NextResponse } from "next/server";
import { readLearnedCases } from "@/lib/learnedCases";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Graded alert outcomes for UI "เคสที่ระบบเรียนรู้".
 * Newest first; caps at 60 for payload size.
 */
export async function GET() {
  try {
    const all = readLearnedCases();
    const cases = [...all]
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
      .slice(0, 60);
    return NextResponse.json({
      updatedAt: new Date().toISOString(),
      count: cases.length,
      total: all.length,
      disclaimerTh:
        "เคสที่ระบบเรียนรู้จากผล NOW จริง — heuristic ไม่การันตีผลในอนาคต และไม่ใช่คำแนะนำการลงทุน",
      cases,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
