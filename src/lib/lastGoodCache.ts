/**
 * Remember last successful screen/hot JSON briefly so Workers can serve
 * a real prior response when BOT_UPSTREAM is briefly down and edge→Binance fails.
 * Never invents rows — only stores payloads that already had data.
 */
import { cacheGet, cacheSet } from "./cache";

const DEFAULT_TTL_MS = 5 * 60_000;

export function rememberLastGood(
  key: string,
  body: unknown,
  ttlMs: number = DEFAULT_TTL_MS
): void {
  if (!body || typeof body !== "object") return;
  const rows = (body as { rows?: unknown }).rows;
  if (!Array.isArray(rows) || rows.length < 1) return;
  cacheSet(key, body, ttlMs);
}

export function getLastGood<T>(key: string): T | null {
  return cacheGet<T>(key);
}
