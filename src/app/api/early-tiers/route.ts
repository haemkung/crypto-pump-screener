import { proxyToUpstream, isCloudflareWorkersRuntime } from "@/lib/upstreamProxy";
import { withCors, corsPreflight } from "@/lib/cors";
import {
  EDGE_EARLY_TIERS_CACHE_URL,
  stashEdgeLastGood,
  matchEdgeLastGood,
} from "@/lib/edgeLastGood";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Isolate-memory last-good (complements Cache API for same-isolate hits). */
let lastGood: { text: string; at: number } | null = null;
const LAST_GOOD_MAX_AGE_MS = 24 * 3600e3;
const MAX_BODY_BYTES = 400_000;
/** Match daemon TIERS_SHOW_MS so web keeps cards across empty restart scans. */
const CARD_TTL_MS = { watch: 8 * 3600e3, ignition: 6 * 3600e3, preOrder: 4 * 3600e3 };

function countCards(text: string): number {
  try {
    const j = JSON.parse(text) as { watch?: unknown[]; ignition?: unknown[]; preOrder?: unknown[] };
    return (
      (Array.isArray(j.watch) ? j.watch.length : 0) +
      (Array.isArray(j.ignition) ? j.ignition.length : 0) +
      (Array.isArray(j.preOrder) ? j.preOrder.length : 0)
    );
  } catch {
    return 0;
  }
}

function filterLiveCards(text: string): { text: string; kept: number } | null {
  try {
    const j = JSON.parse(text) as {
      watch?: Array<{ flaggedAt?: string; firstFlaggedAt?: string; type?: string }>;
      ignition?: Array<{ flaggedAt?: string; firstFlaggedAt?: string; type?: string }>;
      preOrder?: Array<{ flaggedAt?: string; firstFlaggedAt?: string; type?: string }>;
      noteTh?: string;
      [k: string]: unknown;
    };
    const now = Date.now();
    const keep = <T extends { flaggedAt?: string; firstFlaggedAt?: string }>(
      rows: T[] | undefined,
      ttl: number
    ) =>
      (Array.isArray(rows) ? rows : []).filter((r) => {
        const t = Date.parse(r.flaggedAt || r.firstFlaggedAt || "");
        return Number.isFinite(t) && now - t <= ttl;
      });
    const watch = keep(j.watch, CARD_TTL_MS.watch);
    const ignition = keep(j.ignition, CARD_TTL_MS.ignition);
    const preOrder = keep(j.preOrder, CARD_TTL_MS.preOrder);
    if (!watch.length && !ignition.length && !preOrder.length) return null;
    const out = {
      ...j,
      preOrder,
      watch,
      ignition,
      noteTh: j.noteTh || "แสดงการ์ดล่าสุดที่ยังอยู่ใน TTL (สแกนล่าสุดว่างชั่วคราว)",
    };
    return { text: JSON.stringify(out), kept: watch.length + ignition.length + preOrder.length };
  } catch {
    return null;
  }
}
/** Public Pages static last-good — independent of BOT_UPSTREAM / edge cache. */
const PAGES_LAST_GOOD_URL =
  "https://haemkung.github.io/crypto-pump-screener/data/early-tiers.json";

async function fetchPagesLastGood(): Promise<string | null> {
  try {
    const res = await fetch(PAGES_LAST_GOOD_URL, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text.startsWith("{") || text.length > MAX_BODY_BYTES) return null;
    const j = JSON.parse(text) as { updatedAt?: string | null; meta?: { softFail?: boolean } };
    if (!j.updatedAt || j.meta?.softFail) return null;
    return text;
  } catch {
    return null;
  }
}

export async function OPTIONS(req: NextRequest) {
  return corsPreflight(req) || new NextResponse(null, { status: 204 });
}

function jsonText(req: NextRequest, text: string, extra: Record<string, string> = {}) {
  return withCors(
    req,
    new NextResponse(text, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...extra,
      },
    })
  );
}

/**
 * GET /api/early-tiers — confluence-first early tiers from the local daemon.
 * Workers: proxy BOT_UPSTREAM, stash into Cache API last-good. On upstream miss,
 * serve edge/in-memory last-good with X-Early-Tiers-Stale:1 (HTTP 200). Soft-fail
 * empty only when no last-good exists — never hard-blank the SPA.
 */
function wantsFresh(req: NextRequest): boolean {
  const sp = req.nextUrl.searchParams;
  if (sp.has("t") || sp.get("fresh") === "1" || sp.get("bypassCache") === "1") {
    return true;
  }
  const cc = (req.headers.get("cache-control") || "").toLowerCase();
  return cc.includes("no-cache") || cc.includes("no-store");
}

export async function GET(req: NextRequest) {
  try {
    const fresh = wantsFresh(req);
    const proxied = await proxyToUpstream(`/api/early-tiers`, {
      timeoutMs: 12_000,
      retries: 3,
    });
    if (proxied && proxied.ok) {
      const len = Number(proxied.headers.get("content-length") || 0);
      if (len > MAX_BODY_BYTES) return withCors(req, proxied);
      const text = await proxied.text();
      if (text.length <= MAX_BODY_BYTES && text.startsWith("{")) {
        const cards = countCards(text);
        // Permanent rule: never overwrite a non-empty last-good with a fresh empty scan.
        // Empty can be valid (quiet market) — but only after prior cards expire by TTL.
        if (cards > 0) {
          lastGood = { text, at: Date.now() };
          const toStash = new Response(text, {
            status: 200,
            headers: { "Content-Type": "application/json; charset=utf-8" },
          });
          const teed = await stashEdgeLastGood(
            EDGE_EARLY_TIERS_CACHE_URL,
            toStash,
            900
          );
          try {
            await teed.arrayBuffer();
          } catch {
            /* ignore */
          }
          return jsonText(req, text);
        }
        // Upstream empty: prefer still-valid last-good cards (honest age via flaggedAt).
        if (lastGood && Date.now() - lastGood.at < LAST_GOOD_MAX_AGE_MS) {
          const filtered = filterLiveCards(lastGood.text);
          if (filtered && filtered.kept > 0) {
            return jsonText(req, filtered.text, {
              "X-Early-Tiers-Stale": "1",
              "X-Early-Tiers-Source": "memory-ttl",
              "X-Early-Tiers-Cached-At": new Date(lastGood.at).toISOString(),
            });
          }
        }
        // No lasting cards — return live empty (quiet is valid). Still update updatedAt.
        return jsonText(req, text);
      }
      return jsonText(req, text);
    }
    if (proxied) {
      try {
        await proxied.body?.cancel();
      } catch {
        /* ignore */
      }
    }
    if (await isCloudflareWorkersRuntime()) {
      // Prefer last-good over empty soft-fail — even on manual refresh — so Pages
      // never shows only "BOT_UPSTREAM unreachable" with blank panels.
      const edge = await matchEdgeLastGood(
        EDGE_EARLY_TIERS_CACHE_URL,
        "X-Early-Tiers-Stale"
      );
      if (edge) {
        const headers = new Headers(edge.headers);
        if (fresh) headers.set("X-Early-Tiers-Refresh-Miss", "1");
        return withCors(req, new Response(edge.body, { status: 200, headers }));
      }

      if (lastGood && Date.now() - lastGood.at < LAST_GOOD_MAX_AGE_MS) {
        return jsonText(req, lastGood.text, {
          "X-Early-Tiers-Stale": "1",
          "X-Early-Tiers-Cached-At": new Date(lastGood.at).toISOString(),
          "X-Early-Tiers-Source": "memory",
          ...(fresh ? { "X-Early-Tiers-Refresh-Miss": "1" } : {}),
        });
      }
      const pagesText = await fetchPagesLastGood();
      if (pagesText) {
        return jsonText(req, pagesText, {
          "X-Early-Tiers-Stale": "1",
          "X-Early-Tiers-Source": "pages-static",
          ...(fresh ? { "X-Early-Tiers-Refresh-Miss": "1" } : {}),
        });
      }
      return withCors(
        req,
        NextResponse.json(
          {
            updatedAt: null,
            preOrder: [],
            watch: [],
            ignition: [],
            meta: { softFail: true, reason: "upstream_unavailable" },
            noteTh:
              "ข้อมูลค้าง — เซิร์ฟเวอร์และ Pages last-good ยังไม่พร้อม",
          },
          {
            status: 200,
            headers: {
              "X-Early-Tiers-Soft-Fail": "1",
              "Cache-Control": "no-store",
            },
          }
        )
      );
    }
    const { readEarlyTiers } = await import("@/lib/earlyTiers");
    return withCors(
      req,
      NextResponse.json(readEarlyTiers(), { headers: { "Cache-Control": "no-store" } })
    );
  } catch (e) {
    if (lastGood) return jsonText(req, lastGood.text, { "X-Early-Tiers-Stale": "1" });
    try {
      const edge = await matchEdgeLastGood(
        EDGE_EARLY_TIERS_CACHE_URL,
        "X-Early-Tiers-Stale"
      );
      if (edge) return withCors(req, edge);
    } catch {
      /* ignore */
    }
    return withCors(
      req,
      NextResponse.json(
        {
          updatedAt: null,
          preOrder: [],
          watch: [],
          ignition: [],
          error: String(e),
          noteTh: "ข้อมูลค้าง",
        },
        { status: 200 }
      )
    );
  }
}
