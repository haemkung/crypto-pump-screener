"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="th">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          background: "#09090b",
          color: "#fafafa",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          textAlign: "center",
          fontFamily:
            'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        }}
      >
        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>
          เกิดข้อผิดพลาดร้ายแรง
        </h1>
        <p style={{ color: "#a1a1aa", marginBottom: 16, maxWidth: 420 }}>
          แอปพังขณะโหลด — กดลองใหม่ หรือปิดแท็บแล้วเปิดใหม่
        </p>
        {error?.message ? (
          <p
            style={{
              color: "#fb7185",
              fontSize: 12,
              marginBottom: 20,
              wordBreak: "break-word",
              maxWidth: 480,
            }}
          >
            {error.message}
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => reset()}
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
      </body>
    </html>
  );
}
