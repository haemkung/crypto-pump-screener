/**
 * Remember last successful screen/hot JSON so Workers / local Next can serve
 * a real prior response when BOT_UPSTREAM is briefly down.
 * Never invents rows — only stores payloads that already had data.
 *
 * Note: this is in-process memory (dies on isolate recycle). Workers also use
 * the Cache API via edgeLastGood.ts for durable last-good across requests.
 */
import { cacheGet, cacheSet } from "./cache";

/** 90 minutes — covers typical upstream blips + isolate recycle windows. */
const DEFAULT_TTL_MS = 90 * 60_000;

export function rememberLastGood(
  key: string,
  body: unknown,
  ttlMs: number = DEFAULT_TTL_MS
): void {
  if (!body || typeof body !== "object") return;
  const rows = (body as { rows?: unknown }).rows;
  const hot = (body as { hot?: unknown }).hot;
  const hasRows = Array.isArray(rows) && rows.length >= 1;
  const hasHot = Array.isArray(hot) && hot.length >= 1;
  if (!hasRows && !hasHot) return;
  cacheSet(key, body, ttlMs);
}

export function getLastGood<T>(key: string): T | null {
  return cacheGet<T>(key);
}
