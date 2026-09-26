import { NextRequest, NextResponse } from "next/server";
import { mkdir, writeFile, readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { withCors, corsPreflight, isAllowedCorsOrigin } from "@/lib/cors";
import { proxyToUpstream, isCloudflareWorkersRuntime } from "@/lib/upstreamProxy";
import {
  EDGE_EARLY_TIERS_CACHE_URL,
  purgeEdgeLastGood,
} from "@/lib/edgeLastGood";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WAKE_FLAG = path.join(process.cwd(), "logs/early-ignition/wake.flag");
const RATE_FILE = path.join(process.cwd(), "logs/early-ignition/wake-rate.json");
const MIN_INTERVAL_MS = 45_000;
const GLOBAL_MIN_MS = 20_000;

export async function OPTIONS(req: NextRequest) {
  return corsPreflight(req) || new NextResponse(null, { status: 204 });
}

type RateState = { lastAt: number; byIp: Record<string, number> };

async function readRate(): Promise<RateState> {
  try {
    if (!existsSync(RATE_FILE)) return { lastAt: 0, byIp: {} };
    const raw = JSON.parse(await readFile(RATE_FILE, "utf8")) as RateState;
    return {
      lastAt: typeof raw.lastAt === "number" ? raw.lastAt : 0,
      byIp: raw.byIp && typeof raw.byIp === "object" ? raw.byIp : {},
    };
  } catch {
    return { lastAt: 0, byIp: {} };
  }
}

async function writeRate(state: RateState): Promise<void> {
  await mkdir(path.dirname(RATE_FILE), { recursive: true });
  // prune old IPs
  const now = Date.now();
  const byIp: Record<string, number> = {};
  for (const [ip, t] of Object.entries(state.byIp)) {
    if (now - t < 3600_000) byIp[ip] = t;
  }
  await writeFile(
    RATE_FILE,
    JSON.stringify({ lastAt: state.lastAt, byIp }),
    "utf8"
  );
}

function clientIp(req: NextRequest): string {
  const xf = req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for") ||
    req.headers.get("x-real-ip") ||
    "";
  return (xf.split(",")[0] || "unknown").trim() || "unknown";
}

function authorize(req: NextRequest): { ok: boolean; reason?: string } {
  const origin = req.headers.get("origin");
  // No Origin = Workers VPC / curl / same-box — always allow (rate-limited below).
  if (!origin) return { ok: true };
  if (!isAllowedCorsOrigin(origin)) {
    return { ok: false, reason: "origin not allowed" };
  }
  const secret = (process.env.EARLY_WAKE_SECRET || "").trim();
  if (!secret) return { ok: true };
  const hdr =
    req.headers.get("x-cps-wake-token") ||
    req.headers.get("x-wake-token") ||
    "";
  if (hdr === secret) return { ok: true };
  return { ok: false, reason: "wake token required" };
}

/**
 * POST /api/early-daemon/wake
 * Writes a wake flag that watchdog/supervisor poll within a few seconds to
 * kill+restart early-ignition-daemon. Never runs shell from the request.
 * Workers: proxy to BOT_UPSTREAM. Rate-limited. Optional EARLY_WAKE_SECRET.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = authorize(req);
    if (!auth.ok) {
      return withCors(
        req,
        NextResponse.json(
          { ok: false, error: auth.reason || "unauthorized" },
          { status: 401 }
        )
      );
    }

    // On Workers, always proxy to the box (only the box can write the flag).
    if (await isCloudflareWorkersRuntime()) {
      const raw = await req.text().catch(() => "");
      const proxied = await proxyToUpstream("/api/early-daemon/wake", {
        method: "POST",
        body: raw || "{}",
        contentType: "application/json",
        timeoutMs: 10_000,
        retries: 3,
        requireUpstream: true,
      });
      // Best-effort: drop sticky last-good so next GET prefers live upstream.
      try {
        await purgeEdgeLastGood(EDGE_EARLY_TIERS_CACHE_URL);
      } catch {
        /* ignore */
      }
      if (proxied) {
        // Even a 502 from requireUpstream: rewrite to soft queued so UI never
        // sticks on English "BOT_UPSTREAM unreachable".
        if (proxied.status >= 500) {
          try {
            await proxied.body?.cancel();
          } catch {
            /* ignore */
          }
          return withCors(
            req,
            NextResponse.json({
              ok: true,
              queued: false,
              autoHeal: true,
              at: new Date().toISOString(),
              noteTh:
                "เซิร์ฟเวอร์ยังไม่ตอบ — ส่งคำขอปลุกแล้ว และระบบจะรีสตาร์ทอัตโนมัติภายใน 1–2 นาที กด「รีเฟรช」อีกครั้ง",
            })
          );
        }
        return withCors(req, proxied);
      }
      // Tunnel briefly down: still tell UI that auto-heal will recover (heal-bot-once every 2m).
      return withCors(
        req,
        NextResponse.json({
          ok: true,
          queued: false,
          autoHeal: true,
          at: new Date().toISOString(),
          noteTh:
            "อัปสตรีมยังไม่พร้อม — ระบบจะรีสตาร์ท daemon/tunnel อัตโนมัติภายใน 1–2 นาที แล้วกด「รีเฟรช」",
        })
      );
    }

    const ip = clientIp(req);
    const rate = await readRate();
    const now = Date.now();
    if (now - rate.lastAt < GLOBAL_MIN_MS) {
      return withCors(
        req,
        NextResponse.json(
          {
            ok: false,
            error: "rate_limited",
            retryAfterSec: Math.ceil((GLOBAL_MIN_MS - (now - rate.lastAt)) / 1000),
            noteTh: "รอสักครู่แล้วกดปลุกอีกครั้ง",
          },
          { status: 429 }
        )
      );
    }
    const ipLast = rate.byIp[ip] || 0;
    if (now - ipLast < MIN_INTERVAL_MS) {
      return withCors(
        req,
        NextResponse.json(
          {
            ok: false,
            error: "rate_limited",
            retryAfterSec: Math.ceil((MIN_INTERVAL_MS - (now - ipLast)) / 1000),
            noteTh: "กดปลุกบ่อยเกินไป — รอแล้วลองใหม่",
          },
          { status: 429 }
        )
      );
    }

    await mkdir(path.dirname(WAKE_FLAG), { recursive: true });
    const payload = {
      at: new Date().toISOString(),
      reason: "ui-wake",
      ip,
      ua: (req.headers.get("user-agent") || "").slice(0, 120),
    };
    await writeFile(WAKE_FLAG, JSON.stringify(payload) + "\n", "utf8");
    rate.lastAt = now;
    rate.byIp[ip] = now;
    await writeRate(rate);

    return withCors(
      req,
      NextResponse.json({
        ok: true,
        queued: true,
        at: payload.at,
        noteTh:
          "ส่งสัญญาณปลุกแล้ว — ระบบจะรีสตาร์ท daemon ในไม่กี่วินาที แล้วรีเฟรชข้อมูล",
      })
    );
  } catch (e) {
    return withCors(
      req,
      NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
    );
  }
}

/** GET — status only (no side effects). */
export async function GET(req: NextRequest) {
  try {
    if (await isCloudflareWorkersRuntime()) {
      const proxied = await proxyToUpstream("/api/early-daemon/wake", {
        timeoutMs: 8_000,
        retries: 1,
      });
      if (proxied) return withCors(req, proxied);
    }
    const pending = existsSync(WAKE_FLAG);
    let early: { at?: string; ageSec?: number | null; healthy?: boolean } = {};
    const statusPath = path.join(process.cwd(), "logs/early-ignition/status.json");
    if (existsSync(statusPath)) {
      try {
        const raw = JSON.parse(await readFile(statusPath, "utf8")) as {
          at?: string;
          pid?: number;
          ok?: boolean;
        };
        const atMs = raw.at ? Date.parse(raw.at) : NaN;
        const ageSec = Number.isFinite(atMs)
          ? Math.max(0, Math.round((Date.now() - atMs) / 1000))
          : null;
        early = {
          at: raw.at,
          ageSec,
          healthy: ageSec != null && ageSec <= 480,
        };
      } catch {
        /* ignore */
      }
    }
    return withCors(
      req,
      NextResponse.json({
        ok: true,
        wakePending: pending,
        earlyDaemon: early,
      })
    );
  } catch (e) {
    return withCors(
      req,
      NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
    );
  }
}
