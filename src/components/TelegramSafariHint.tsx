"use client";

import { useEffect, useState } from "react";

/** Tiny banner for Telegram iOS WebView: tip to open in Safari if blank. */
export function TelegramSafariHint() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      const ua = navigator.userAgent || "";
      const w = window as Window & {
        TelegramWebviewProxy?: unknown;
        Telegram?: { WebApp?: unknown };
      };
      const isTelegram =
        /Telegram/i.test(ua) ||
        typeof w.TelegramWebviewProxy !== "undefined" ||
        !!w.Telegram?.WebApp;
      setShow(isTelegram);
    } catch {
      // ignore
    }
  }, []);

  if (!show) return null;

  return (
    <div
      role="status"
      style={{
        background: "#1e3a5f",
        color: "#e0f2fe",
        fontSize: 12,
        lineHeight: 1.4,
        padding: "8px 12px",
        textAlign: "center",
        borderBottom: "1px solid #334155",
        fontFamily:
          'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      ถ้าหน้าจอดำใน Telegram → เปิดใน Safari (เมนู ⋯ → Open in Safari)
    </div>
  );
}
