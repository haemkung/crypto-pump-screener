import type { Metadata, Viewport } from "next";
import "./globals.css";
import { TelegramSafariHint } from "@/components/TelegramSafariHint";

export const metadata: Metadata = {
  title: "Crypto Pump Pattern Screener | สแกนรูปแบบ Pump",
  description:
    "Thai-friendly Binance USDⓈ-M Futures screener for 4-leg pump patterns. Not financial advice.",
  other: {
    "color-scheme": "dark",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  themeColor: "#09090b",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="th" className="dark" style={{ colorScheme: "dark" }}>
      <body
        className="min-h-screen antialiased"
        style={{
          background: "#09090b",
          color: "#fafafa",
          minHeight: "100vh",
          margin: 0,
          fontFamily:
            'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        }}
      >
        {/* Critical fallback if Tailwind CSS fails to parse in old WebViews */}
        <style
          dangerouslySetInnerHTML={{
            __html: `html,body{background:#09090b!important;color:#fafafa!important}a{color:#6ee7b7}`,
          }}
        />
        <TelegramSafariHint />
        <noscript>
          <div style={{ padding: 24, textAlign: "center" }}>
            เปิด JavaScript เพื่อใช้สกรีนเนอร์ หรือเปิดลิงก์ใน Safari
          </div>
        </noscript>
        {children}
      </body>
    </html>
  );
}
