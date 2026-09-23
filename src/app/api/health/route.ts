import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Lightweight liveness for the BOT_UPSTREAM box (and Workers fallthrough).
 * Does not call Binance — supervisor + ops scripts use /api/screen for deep health.
 */
export async function GET() {
  const role = (process.env.BOT_ROLE || "").trim() || null;
  const disableUpstream =
    (process.env.DISABLE_BOT_UPSTREAM || "").trim().toLowerCase() === "1" ||
    (process.env.DISABLE_BOT_UPSTREAM || "").trim().toLowerCase() === "true";

  let supervisor: unknown = null;
  const candidates = [
    path.join(process.cwd(), "logs/bot-upstream/status.json"),
    "/tmp/crypto-pump-bot-upstream-status.json",
    "/tmp/crypto-pump-bot-upstream/status.json",
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      supervisor = JSON.parse(await readFile(p, "utf8"));
      break;
    } catch {
      // ignore
    }
  }

  return NextResponse.json({
    ok: true,
    service: "crypto-pump-screener",
    role,
    upstreamMode: disableUpstream,
    ts: new Date().toISOString(),
    supervisor,
  });
}
