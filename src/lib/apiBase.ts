/**
 * API origin for static GitHub Pages (or any host that is not the Workers app).
 * Same-origin Next/Workers leaves this empty so `/api/...` stays relative.
 *
 * Resolution order (browser):
 * 1. `?api=` query override
 * 2. `window.CPS_API_BASE`
 * 3. `window.CPS_DEFAULT_API_BASE` (set by docs/config.js on Pages)
 */
export function getApiBase(): string {
  if (typeof window === "undefined") return "";
  try {
    const q = new URLSearchParams(window.location.search).get("api");
    if (q && q.trim()) return q.trim().replace(/\/$/, "");
  } catch {
    // ignore
  }
  const w = window as Window & {
    CPS_API_BASE?: string;
    CPS_DEFAULT_API_BASE?: string;
  };
  const fromWin = (w.CPS_API_BASE || w.CPS_DEFAULT_API_BASE || "").trim();
  return fromWin.replace(/\/$/, "");
}

/** Prefix a path like `/api/screen` with the configured API base when set. */
export function apiUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  const base = getApiBase();
  return base ? `${base}${p}` : p;
}
