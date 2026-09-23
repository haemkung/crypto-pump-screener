import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Screener } from "@/components/Screener";
import { TelegramSafariHint } from "@/components/TelegramSafariHint";
import "./styles.css";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Missing #root");
}

createRoot(rootEl).render(
  <StrictMode>
    <TelegramSafariHint />
    <ErrorBoundary>
      <Screener />
    </ErrorBoundary>
  </StrictMode>
);
