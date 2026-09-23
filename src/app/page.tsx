import { Screener } from "@/components/Screener";
import { ErrorBoundary } from "@/components/ErrorBoundary";

/**
 * Static HTML shell only — Screener is client-side and fetches /api/* after paint.
 * force-dynamic + nodejs SSR was blowing Workers CPU (Error 1102) on cold starts.
 */
export const dynamic = "force-static";
export const revalidate = false;

export default function Home() {
  return (
    <ErrorBoundary>
      <Screener />
    </ErrorBoundary>
  );
}
