/**
 * Durable last-good for Workers via the Cache API.
 *
 * On a successful BOT_UPSTREAM proxy we tee the Response body:
 *   - one branch streams to the client (no buffering / JSON.parse → avoids Error 1102)
 *   - the other is put into caches.open("cps-last-good") under a stable internal URL
 *
 * On upstream failure we match that URL and return it with an X-*-Stale header.
 * Never invents rows — only replays a prior successful upstream body.
 */
import { getCloudflareContext } from "@opennextjs/cloudflare";

export const EDGE_SCREEN_CACHE_URL =
  "https://cps-last-good.internal/api/screen";
export const EDGE_HOT_CACHE_URL = "https://cps-last-good.internal/api/hot";

const CACHE_NAME = "cps-last-good";
const DEFAULT_MAX_AGE_SEC = 3600;

function getCaches(): CacheStorage | null {
  try {
    const c = (globalThis as unknown as { caches?: CacheStorage }).caches;
    return c ?? null;
  } catch {
    return null;
  }
}

async function openCache(): Promise<Cache | null> {
  const cs = getCaches();
  if (!cs) return null;
  try {
    return await cs.open(CACHE_NAME);
  } catch {
    try {
      return cs.default;
    } catch {
      return null;
    }
  }
}

function cacheKey(url: string): Request {
  return new Request(url, { method: "GET" });
}

function schedule(p: Promise<unknown>): void {
  try {
    // Prefer waitUntil so the put finishes after the client response is sent.
    // getCloudflareContext is sync-capable via async:true in OpenNext.
    void getCloudflareContext({ async: true })
      .then((ctx) => {
        const wu = (
          ctx as
            | { ctx?: { waitUntil?: (x: Promise<unknown>) => void } }
            | undefined
        )?.ctx?.waitUntil;
        if (typeof wu === "function") {
          wu.call(
            (ctx as { ctx: { waitUntil: (x: Promise<unknown>) => void } }).ctx,
            p
          );
          return;
        }
        void p.catch(() => {});
      })
      .catch(() => {
        void p.catch(() => {});
      });
  } catch {
    void p.catch(() => {});
  }
}

/**
 * Tee a successful upstream Response into the edge cache and return the
 * client-facing branch. No JSON.parse; body is never fully buffered in JS.
 */
export async function stashEdgeLastGood(
  cacheUrl: string,
  res: Response,
  maxAgeSec: number = DEFAULT_MAX_AGE_SEC
): Promise<Response> {
  if (!res.ok || !res.body) return res;

  const cache = await openCache();
  if (!cache) return res;

  let forClient: ReadableStream<Uint8Array> | null = null;
  try {
    const teed = res.body.tee();
    forClient = teed[0];
    const forCache = teed[1];

    const storeHeaders = new Headers();
    storeHeaders.set(
      "Content-Type",
      res.headers.get("Content-Type") || "application/json"
    );
    storeHeaders.set("Cache-Control", `public, max-age=${maxAgeSec}`);
    storeHeaders.set("X-Cached-At", new Date().toISOString());

    const toStore = new Response(forCache, {
      status: 200,
      headers: storeHeaders,
    });
    schedule(cache.put(cacheKey(cacheUrl), toStore));

    const outHeaders = new Headers(res.headers);
    outHeaders.set("X-Edge-Last-Good", "stored");
    return new Response(forClient, {
      status: res.status,
      statusText: res.statusText,
      headers: outHeaders,
    });
  } catch (e) {
    console.error("stashEdgeLastGood failed", String(e));
    // Body already teed — must return the client branch, not the spent original.
    if (forClient) {
      return new Response(forClient, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    }
    return res;
  }
}

/**
 * Return a previously stashed body as HTTP 200 with the given stale header.
 * Does not parse the body.
 */
export async function matchEdgeLastGood(
  cacheUrl: string,
  staleHeader: string
): Promise<Response | null> {
  const cache = await openCache();
  if (!cache) return null;
  try {
    const hit = await cache.match(cacheKey(cacheUrl));
    if (!hit || !hit.body) return null;
    const headers = new Headers();
    headers.set(
      "Content-Type",
      hit.headers.get("Content-Type") || "application/json"
    );
    headers.set("Cache-Control", "no-store");
    headers.set(staleHeader, "1");
    headers.set("X-Upstream-Via", "edge-cache");
    const cachedAt = hit.headers.get("X-Cached-At");
    if (cachedAt) headers.set("X-Cached-At", cachedAt);
    return new Response(hit.body, { status: 200, headers });
  } catch (e) {
    console.error("matchEdgeLastGood failed", String(e));
    return null;
  }
}
