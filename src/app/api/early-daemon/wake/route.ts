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

const GH_OWNER = "haemkung";
const GH_REPO = "crypto-pump-screener";
const GH_WORKFLOW = "publish-last-good.yml";

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
  const xf =
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for") ||
    req.headers.get("x-real-ip") ||
    "";
  return (xf.split(",")[0] || "unknown").trim() || "unknown";
}

function authorize(req: NextRequest): { ok: boolean; reason?: string } {
  const origin = req.headers.get("origin");
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

type GhDispatchResult = {
  attempted: boolean;
  ok: boolean;
  status?: number;
  detail?: string;
  workflow?: string;
};

/**
 * Independent of BOT_UPSTREAM: dispatch GitHub Actions publish-last-good.yml.
 * Uses server-held GITHUB_WAKE_TOKEN (PAT with repo scope) when present.
 * Never invents a token — if unset, returns attempted:false.
 */
async function dispatchGithubWake(reason: string): Promise<GhDispatchResult> {
  const token = (process.env.GITHUB_WAKE_TOKEN || "").trim();
  if (!token) {
    return {
      attempted: false,
      ok: false,
      detail: "GITHUB_WAKE_TOKEN not configured on Workers",
      workflow: GH_WORKFLOW,
    };
  }
  try {
    const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/workflows/${GH_WORKFLOW}/dispatches`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "cps-wake",
      },
      body: JSON.stringify({
        ref: "main",
        inputs: { reason: reason.slice(0, 100) },
      }),
    });
    if (res.status === 204 || res.status === 200) {
      return {
        attempted: true,
        ok: true,
        status: res.status,
        workflow: GH_WORKFLOW,
        detail: "workflow_dispatch accepted",
      };
    }
    const body = await res.text().catch(() => "");
    return {
      attempted: true,
      ok: false,
      status: res.status,
      workflow: GH_WORKFLOW,
      detail: body.slice(0, 240) || `HTTP ${res.status}`,
    };
  } catch (e) {
    return {
      attempted: true,
      ok: false,
      workflow: GH_WORKFLOW,
      detail: String(e).slice(0, 240),
    };
  }
}

function wakeJson(
  req: NextRequest,
  body: Record<string, unknown>,
  status = 200
) {
  return withCors(req, NextResponse.json(body, { status }));
}

/**
 * POST /api/early-daemon/wake
 *
 * Truthful wake — never claims box restart when BOT_UPSTREAM is down.
 *
 * Paths (Workers):
 *  1) Proxy BOT_UPSTREAM (writes wake.flag on the box) when tunnel/Next alive
 *  2) Independently dispatch GitHub Actions publish-last-good.yml when
 *     GITHUB_WAKE_TOKEN is configured (refreshes Pages static last-good)
 *  3) If neither works: ok:false with an honest Thai note (no fake autoHeal)
 *
 * Local upstream: writes wake.flag for heal/supervisor to consume.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = authorize(req);
    if (!auth.ok) {
      return wakeJson(
        req,
        { ok: false, error: auth.reason || "unauthorized" },
        401
      );
    }

    if (await isCloudflareWorkersRuntime()) {
      const raw = await req.text().catch(() => "");
      let upstreamOk = false;
      let upstreamNote: string | null = null;
      let upstreamStatus: number | null = null;

      const proxied = await proxyToUpstream("/api/early-daemon/wake", {
        method: "POST",
        body: raw || "{}",
        contentType: "application/json",
        timeoutMs: 10_000,
        retries: 2,
        requireUpstream: true,
      });

      try {
        await purgeEdgeLastGood(EDGE_EARLY_TIERS_CACHE_URL);
      } catch {
        /* ignore */
      }

      if (proxied) {
        upstreamStatus = proxied.status;
        if (proxied.status >= 200 && proxied.status < 300) {
          upstreamOk = true;
          try {
            const j = (await proxied.json()) as { noteTh?: string };
            upstreamNote = j.noteTh || "upstream wake accepted";
          } catch {
            upstreamNote = "upstream wake accepted";
          }
        } else {
          try {
            await proxied.body?.cancel();
          } catch {
            /* ignore */
          }
          upstreamNote = `upstream HTTP ${proxied.status}`;
        }
      } else {
        upstreamNote = "BOT_UPSTREAM unreachable";
      }

      // Independent path — does NOT need the box/tunnel
      const gh = await dispatchGithubWake(
        upstreamOk ? "wake-after-upstream-ok" : "wake-upstream-down"
      );

      const at = new Date().toISOString();
      if (upstreamOk) {
        return wakeJson(req, {
          ok: true,
          at,
          upstreamWake: true,
          upstreamStatus,
          githubDispatch: gh,
          queued: true,
          noteTh: gh.ok
            ? "ส่งปลุกไปยังเซิร์ฟเวอร์แล้ว และสั่งรีเฟรช Pages last-good ผ่าน GitHub Actions แล้ว"
            : upstreamNote ||
              "ส่งสัญญาณปลุกไปยังเซิร์ฟเวอร์แล้ว — รอ daemon รีสตาร์ทแล้วกด「รีเฟรช」",
        });
      }

      if (gh.ok) {
        return wakeJson(req, {
          ok: true,
          at,
          upstreamWake: false,
          upstreamStatus,
          githubDispatch: gh,
          queued: false,
          pagesRefreshDispatched: true,
          noteTh:
            "เซิร์ฟเวอร์ (tunnel/box) ไม่ตอบ — สั่ง GitHub Actions รีเฟรช Pages last-good แล้ว (ไม่สามารถสตาร์ทโปรเซสบน box จากเว็บได้) กด「รีเฟรช」หลัง 1–2 นาที",
        });
      }

      // Honest failure — do NOT claim autoHeal will fix a dead box from here
      return wakeJson(
        req,
        {
          ok: false,
          at,
          upstreamWake: false,
          upstreamStatus,
          githubDispatch: gh,
          pagesRefreshDispatched: false,
          reason: "no_independent_wake_path",
          noteTh: gh.attempted
            ? `เซิร์ฟเวอร์ไม่ตอบ และ GitHub wake ล้มเหลว (${gh.detail || gh.status}) — แสดงค่าล่าสุดจาก Pages static หากมี`
            : "เซิร์ฟเวอร์ (tunnel/box) ไม่ตอบ และยังไม่มี GITHUB_WAKE_TOKEN บน Workers — ปุ่มปลุกจากเว็บปลุก box ไม่ได้ ระบบพึ่ง heal บนเครื่อง + Pages last-good",
        },
        503
      );
    }

    // Local upstream box path
    const ip = clientIp(req);
    const rate = await readRate();
    const now = Date.now();
    if (now - rate.lastAt < GLOBAL_MIN_MS) {
      return wakeJson(
        req,
        {
          ok: false,
          error: "rate_limited",
          retryAfterSec: Math.ceil((GLOBAL_MIN_MS - (now - rate.lastAt)) / 1000),
          noteTh: "รอสักครู่แล้วกดปลุกอีกครั้ง",
        },
        429
      );
    }
    const ipLast = rate.byIp[ip] || 0;
    if (now - ipLast < MIN_INTERVAL_MS) {
      return wakeJson(
        req,
        {
          ok: false,
          error: "rate_limited",
          retryAfterSec: Math.ceil((MIN_INTERVAL_MS - (now - ipLast)) / 1000),
          noteTh: "กดปลุกบ่อยเกินไป — รอแล้วลองใหม่",
        },
        429
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

    return wakeJson(req, {
      ok: true,
      queued: true,
      upstreamWake: true,
      at: payload.at,
      noteTh:
        "ส่งสัญญาณปลุกแล้ว — heal/supervisor จะรีสตาร์ท daemon ในไม่กี่วินาที แล้วรีเฟรชข้อมูล",
    });
  } catch (e) {
    return wakeJson(req, { ok: false, error: String(e) }, 500);
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
      return wakeJson(req, {
        ok: true,
        wakePending: false,
        upstreamReachable: false,
        githubWakeConfigured: !!(process.env.GITHUB_WAKE_TOKEN || "").trim(),
        noteTh: "อัปสตรีมไม่ตอบ — GET สถานะจาก Workers อย่างเดียว",
      });
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
    return wakeJson(req, {
      ok: true,
      wakePending: pending,
      earlyDaemon: early,
      upstreamReachable: true,
    });
  } catch (e) {
    return wakeJson(req, { ok: false, error: String(e) }, 500);
  }
}
