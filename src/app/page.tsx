import { Screener } from "@/components/Screener";
import { ErrorBoundary } from "@/components/ErrorBoundary";

/** Force dynamic so WebViews that choke on static hydration still get a live render. */
export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <ErrorBoundary>
      <Screener />
    </ErrorBoundary>
  );
}
