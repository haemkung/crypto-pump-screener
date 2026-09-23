import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ScreenerClient } from "@/components/ScreenerClient";

/**
 * Static HTML shell only — Screener loads client-side after paint.
 * Direct Screener import previously produced a ~764KB server page.js and
 * blew Workers CPU (Error 1102 / plain "Internal Server Error" on /).
 */
export const dynamic = "force-static";
export const revalidate = false;

export default function Home() {
  return (
    <ErrorBoundary>
      <ScreenerClient />
    </ErrorBoundary>
  );
}
