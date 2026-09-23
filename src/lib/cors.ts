/**
 * CORS for GitHub Pages UI → Workers API (and local dev).
 * Simple GETs need Access-Control-Allow-Origin on the response.
 */
import { NextRequest, NextResponse } from "next/server";

const EXTRA = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function isAllowedCorsOrigin(origin: string | null): boolean {
  if (!origin) return false;
  if (
    origin === "https://haemkung.github.io" ||
    origin === "http://localhost:3000" ||
    origin === "http://127.0.0.1:3000" ||
    origin === "http://localhost:4173" ||
    origin === "http://127.0.0.1:4173"
  ) {
    return true;
  }
  if (EXTRA.includes(origin)) return true;
  // Preview Pages / user forks on github.io
  try {
    const u = new URL(origin);
    if (u.protocol === "https:" && u.hostname.endsWith(".github.io")) {
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

export function corsHeaderRecord(
  requestOrigin: string | null
): Record<string, string> {
  if (!isAllowedCorsOrigin(requestOrigin)) return {};
  return {
    "Access-Control-Allow-Origin": requestOrigin as string,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

/** Attach CORS to any Response (including streamed VPC pass-through). */
export function withCors(req: NextRequest | Request, res: Response): Response {
  const origin =
    "headers" in req ? req.headers.get("origin") : null;
  const extra = corsHeaderRecord(origin);
  if (!Object.keys(extra).length) return res;

  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) {
    headers.set(k, v);
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

export function corsPreflight(req: NextRequest): NextResponse | null {
  if (req.method !== "OPTIONS") return null;
  const origin = req.headers.get("origin");
  if (!isAllowedCorsOrigin(origin)) {
    return new NextResponse(null, { status: 204 });
  }
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaderRecord(origin),
  });
}
