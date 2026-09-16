export default function Loading() {
  return (
    <div
      style={{
        minHeight: "100dvh",
        background: "#09090b",
        color: "#fafafa",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        fontFamily:
          'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      <p style={{ fontSize: 18, fontWeight: 600 }}>กำลังโหลด…</p>
    </div>
  );
}
