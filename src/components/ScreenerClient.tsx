"use client";

import nextDynamic from "next/dynamic";

/**
 * Client-only wrapper so next/dynamic `{ ssr: false }` is legal.
 * Keeps the server page.js tiny (avoids Workers Error 1102 on /).
 */
const Screener = nextDynamic(
  () => import("@/components/Screener").then((m) => m.Screener),
  {
    ssr: false,
    loading: () => (
      <div
        style={{
          padding: 24,
          textAlign: "center",
          color: "#a1a1aa",
          fontFamily:
            'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        }}
      >
        กำลังโหลดสกรีนเนอร์…
      </div>
    ),
  }
);

export function ScreenerClient() {
  return <Screener />;
}
