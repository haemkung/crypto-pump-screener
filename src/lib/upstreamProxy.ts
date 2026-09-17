/**
 * On Cloudflare Workers, Binance often returns 403 from edge IPs, and
 * learning JSON (data/*.json) lives only on the bot machine.
 *
 * Prefer Workers VPC binding BOT_UPSTREAM → named Cloudflare Tunnel → local Next :3000.
 * Fall back to UPSTREAM_ORIGIN / BOT_ORIGIN (public URL) when set.
 * No public trycloudflare URL — only workers.dev is public.
 *
 * CRITICAL: local Next (the bot upstream) must NEVER use BOT_UPSTREAM — remote
 * bindings can hang on getCloudflareContext and/or self-proxy :3000 → deadlock.
 */
import { getCloudflareContext } from "@opennextjs/cloudflare";

const CF_CONTEXT_TIMEOUT_MS = 600;

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
};

type FetcherLike = { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };

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

/**
 * Proxy a request to the bot (VPC tunnel or UPSTREAM_ORIGIN).
 * Defaults to GET (existing callers). Pass method + body for POST.
 * Returns null when this process should handle the request locally.
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

  // 1) Workers VPC → named tunnel → localhost:3000
  const vpc = await botUpstreamFetcher();
  if (vpc) {
    try {
      const res = await vpc.fetch(`http://127.0.0.1:3000${path}`, init);
      const text = await res.text();
      return wrap(
        text,
        res.status,
        res.headers.get("Content-Type"),
        `vpc:${res.status}`
      );
    } catch (e) {
      console.error("BOT_UPSTREAM fetch failed", String(e));
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

  // 2) Optional public origin (legacy / emergency)
  const origin = upstreamOrigin();
  if (!origin) return null;
  const url = `${origin}${path}`;
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    return wrap(
      text,
      res.status,
      res.headers.get("Content-Type"),
      `origin:${res.status}`
    );
  } catch {
    return null;
  }
}
