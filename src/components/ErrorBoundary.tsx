"use client";

import { Component, type ReactNode } from "react";

type Props = {
  children: ReactNode;
};

type State = {
  hasError: boolean;
  message: string;
};

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: "" };

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      message: error?.message || "Unknown error",
    };
  }

  componentDidCatch(error: Error) {
    // Keep console visibility for WebView debugging without crashing the tree.
    console.error("[ErrorBoundary]", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            minHeight: "40vh",
            margin: 16,
            padding: 20,
            borderRadius: 12,
            border: "1px solid #3f3f46",
            background: "#18181b",
            color: "#fafafa",
            fontFamily:
              'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            textAlign: "center",
          }}
        >
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 8px" }}>
            ส่วนสกรีนเนอร์โหลดไม่สำเร็จ
          </h2>
          <p style={{ color: "#a1a1aa", fontSize: 14, margin: "0 0 12px" }}>
            ถ้าหน้าจอดำใน Telegram ให้เปิดใน Safari (เมนู ⋯ → Open in Safari)
          </p>
          {this.state.message ? (
            <p
              style={{
                color: "#fb7185",
                fontSize: 12,
                margin: "0 0 16px",
                wordBreak: "break-word",
              }}
            >
              {this.state.message}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => this.setState({ hasError: false, message: "" })}
            style={{
              background: "#059669",
              color: "#fff",
              border: "none",
              borderRadius: 10,
              padding: "10px 20px",
              fontSize: 15,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            ลองใหม่
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
