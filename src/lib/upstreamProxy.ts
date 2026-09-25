/**
 * On Cloudflare Workers, Binance can be blocked from some edge IPs, and
 * learning JSON (data/*.json) lives primarily on the bot machine.
 *
 * Prefer Workers VPC binding BOT_UPSTREAM → named Cloudflare Tunnel → local Next :3000.
 * Fall back to UPSTREAM_ORIGIN / BOT_ORIGIN (public URL) when set.
 * If VPC/tunnel is down (5xx / timeout / error), fall through to null so each
 * route can handle the request locally (Workers → Binance multi-host, etc.).
 *
 * CRITICAL: local Next (the bot upstream) must NEVER use BOT_UPSTREAM — remote
 * bindings can hang on getCloudflareContext and/or self-proxy :3000 → deadlock.
 *
 * CRITICAL: never buffer large upstream bodies with res.text() on Workers.
 * /api/screen is ~1.5MB; buffering + JSON.parse caused Error 1102 (CPU/memory).
 * Stream pass-through instead.
 */
import { getCloudflareContext } from "@opennextjs/cloudflare";

const CF_CONTEXT_TIMEOUT_MS = 600;
/** Screen builds often take 1–8s; under load can exceed 10s. Old 8s timeout caused false 503s. */
const VPC_FETCH_TIMEOUT_MS = 25_000;
const VPC_FETCH_RETRIES = 2;
const VPC_RETRY_GAP_MS = 400;

export function upstreamOrigin(): string | null {
  const v =
    process.env.UPSTREAM_ORIGIN ||
    process.env.BOT_ORIGIN ||
    "";
  const t = v.trim().replace(/\/$/, "");
  return t || null;
}

export type ProxyToUpstreamOptions = {
  method?: string;
  body?: string | null;
  contentType?: string | null;
  /** When true, 5xx from VPC is returned as-is (rare). Default: fall through. */
  requireUpstream?: boolean;
  /** Override fetch timeout (ms). */
  timeoutMs?: number;
  /** Override retry count (attempts). Default 2. */
  retries?: number;
};

type FetcherLike = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

function proxyDisabledOnThisProcess(): boolean {
  const v = (process.env.DISABLE_BOT_UPSTREAM || "").trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  const role = (process.env.BOT_ROLE || "").trim().toLowerCase();
  if (role === "upstream" || role === "bot") return true;
  return false;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function botUpstreamFetcher(): Promise<FetcherLike | null> {
  if (proxyDisabledOnThisProcess()) return null;
  try {
    const ctx = await withTimeout(
      getCloudflareContext({ async: true }),
      CF_CONTEXT_TIMEOUT_MS
    );
    if (!ctx) return null;
    const env = ctx?.env as { BOT_UPSTREAM?: FetcherLike } | undefined;
    if (env?.BOT_UPSTREAM?.fetch) return env.BOT_UPSTREAM;
  } catch {
    // Local Next / no Workers runtime — no VPC binding
  }
  return null;
}

/**
 * True when running inside Cloudflare Workers / OpenNext edge isolate.
 * Used to skip CPU-heavy local handlers (buildScreen) that trigger Error 1102.
 */
export async function isCloudflareWorkersRuntime(): Promise<boolean> {
  if (proxyDisabledOnThisProcess()) return false;
  try {
    const ctx = await withTimeout(
      getCloudflareContext({ async: true }),
      CF_CONTEXT_TIMEOUT_MS
    );
    return !!(ctx && ctx.env);
  } catch {
    return false;
  }
}

function passThrough(res: Response, via: string): Response {
  const headers = new Headers();
  const ct = res.headers.get("Content-Type");
  if (ct) headers.set("Content-Type", ct);
  else headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Upstream-Via", via);
  // Stream body — do NOT res.text() / res.json() (screen ~1.5MB → 1102).
  return new Response(res.body, {
    status: res.status,
    headers,
  });
}

function wrap(
  text: string,
  status: number,
  contentType: string | null,
  via: string
): Response {
  return new Response(text, {
    status,
    headers: {
      "Content-Type": contentType || "application/json",
      "Cache-Control": "no-store",
      "X-Upstream-Via": via,
    },
  });
}

async function cancelBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // ignore
  }
}

/**
 * Proxy a request to the bot (VPC tunnel or UPSTREAM_ORIGIN).
 * Defaults to GET (existing callers). Pass method + body for POST.
 * Returns null when this process should handle the request locally
 * (including when VPC/tunnel returns 5xx — so Workers can fetch Binance).
 */
export async function proxyToUpstream(
  pathWithQuery: string,
  opts?: ProxyToUpstreamOptions
): Promise<Response | null> {
  if (proxyDisabledOnThisProcess()) return null;

  const path = pathWithQuery.startsWith("/") ? pathWithQuery : `/${pathWithQuery}`;
  const method = (opts?.method || "GET").toUpperCase();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts?.contentType) {
    headers["Content-Type"] = opts.contentType;
  } else if (method !== "GET" && method !== "HEAD" && opts?.body != null) {
    headers["Content-Type"] = "application/json";
  }
  const init: RequestInit = {
    method,
    headers,
    cache: "no-store",
  };
  if (method !== "GET" && method !== "HEAD" && opts?.body != null) {
    init.body = opts.body;
  }

  const timeoutMs = opts?.timeoutMs ?? VPC_FETCH_TIMEOUT_MS;
  const attempts = Math.max(1, opts?.retries ?? VPC_FETCH_RETRIES);

  // 1) Workers VPC → named tunnel → localhost:3000
  const vpc = await botUpstreamFetcher();
  if (vpc) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await withTimeout(
          vpc.fetch(`http://127.0.0.1:3000${path}`, init),
          timeoutMs
        );
        if (!res) {
          console.error(
            `BOT_UPSTREAM timed out (attempt ${attempt}/${attempts});`,
            attempt < attempts ? "retrying" : "falling through"
          );
          if (attempt < attempts) {
            await sleep(VPC_RETRY_GAP_MS * attempt);
            continue;
          }
          break;
        }
        if (res.status >= 500 && !opts?.requireUpstream) {
          console.error(
            "BOT_UPSTREAM returned",
            res.status,
            `(attempt ${attempt}/${attempts});`,
            attempt < attempts ? "retrying" : "falling through to local handler"
          );
          await cancelBody(res);
          if (attempt < attempts) {
            await sleep(VPC_RETRY_GAP_MS * attempt);
            continue;
          }
          break;
        }
        return passThrough(res, `vpc:${res.status}`);
      } catch (e) {
        console.error(
          `BOT_UPSTREAM fetch failed (attempt ${attempt}/${attempts});`,
          String(e)
        );
        if (attempt < attempts) {
          await sleep(VPC_RETRY_GAP_MS * attempt);
          continue;
        }
        if (opts?.requireUpstream) {
          return wrap(
            JSON.stringify({
              error: "BOT_UPSTREAM unreachable (named tunnel / local :3000?)",
              detail: String(e),
            }),
            502,
            "application/json",
            "vpc-fail"
          );
        }
      }
    }
  }

  // 2) Optional public origin (legacy / emergency)
  const origin = upstreamOrigin();
  if (!origin) return null;
  const url = `${origin}${path}`;
  try {
    const res = await withTimeout(fetch(url, init), timeoutMs);
    if (!res) return null;
    if (res.status >= 500 && !opts?.requireUpstream) {
      await cancelBody(res);
      return null;
    }
    return passThrough(res, `origin:${res.status}`);
  } catch {
    return null;
  }
}
