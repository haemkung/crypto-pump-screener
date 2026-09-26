import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { withCors, corsPreflight } from "@/lib/cors";
import { proxyToUpstream, isCloudflareWorkersRuntime } from "@/lib/upstreamProxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Lightweight liveness for the BOT_UPSTREAM box (and Workers fallthrough).
 * Does not call Binance — supervisor + ops scripts use /api/screen for deep health.
 */
export async function OPTIONS(req: NextRequest) {
  return corsPreflight(req) || new NextResponse(null, { status: 204 });
}

export async function GET(req: NextRequest) {
  try {
    if (await isCloudflareWorkersRuntime()) {
      const proxied = await proxyToUpstream("/api/health", {
        timeoutMs: 8_000,
        retries: 1,
      });
      if (proxied && proxied.ok) return withCors(req, proxied);
    }
  } catch {
    /* fall through to local */
  }
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

  let earlyDaemon: unknown = null;
  const earlyStatusPath = path.join(process.cwd(), "logs/early-ignition/status.json");
  if (existsSync(earlyStatusPath)) {
    try {
      const raw = JSON.parse(await readFile(earlyStatusPath, "utf8")) as {
        at?: string;
        pid?: number;
        ok?: boolean;
        phase?: string;
      };
      const atMs = raw.at ? Date.parse(raw.at) : NaN;
      const ageSec = Number.isFinite(atMs)
        ? Math.max(0, Math.round((Date.now() - atMs) / 1000))
        : null;
      earlyDaemon = {
        ...raw,
        ageSec,
        healthy: ageSec != null && ageSec <= 480,
      };
    } catch {
      earlyDaemon = { ok: false, error: "unreadable" };
    }
  }

  return withCors(
    req,
    NextResponse.json({
      ok: true,
      service: "crypto-pump-screener",
      role,
      upstreamMode: disableUpstream,
      ts: new Date().toISOString(),
      supervisor,
      earlyDaemon,
    })
  );
}
