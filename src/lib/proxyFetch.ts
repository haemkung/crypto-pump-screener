import { NextResponse } from "next/server";

export async function proxyGet(path: string, hosts: string[]) {
  let lastErr = "";
  for (const host of hosts) {
    const url = `${host}${path}`;
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const text = await res.text();
      if (res.ok) {
        return new NextResponse(text, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      lastErr = `${res.status} ${url} ${text.slice(0, 120)}`;
      if (![418, 429, 451, 403, 502, 503].includes(res.status)) {
        return new NextResponse(text, {
          status: res.status,
          headers: { "Content-Type": "application/json" },
        });
      }
    } catch (e) {
      lastErr = String(e);
    }
  }
  return NextResponse.json({ error: lastErr || "upstream failed" }, { status: 502 });
}

export const FAPI_HOSTS = [
  "https://www.binance.com",
  "https://fapi.binance.com",
];
export const SPOT_HOSTS = [
  "https://data-api.binance.vision",
  "https://www.binance.com",
  "https://api.binance.com",
];
