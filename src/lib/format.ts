export function fmtPrice(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  if (n >= 0.01) return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
  return n.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

export function fmtVol(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

export function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}

export function fmtFunding(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(4)}%`;
}

export function fmtRatio(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(2)}x`;
}

export function flagLabelTh(flag: string): string {
  const map: Record<string, string> = {
    early_move: "Early",
    late_chase: "Late/Chase",
    neg_funding: "Funding−",
    thin_liquidity: "Thin Liq",
    no_spot: "No Spot",
    high_volume: "High Vol",
    oi_rising: "OI↑",
    short_squeeze_fuel: "Squeeze Fuel",
    catalyst: "Catalyst",
  };
  return map[flag] || flag;
}

/** Convert ISO UTC to Asia/Bangkok display */
export function fmtBangkok(iso: string): string {
  try {
    const d = new Date(iso);
    return (
      d.toLocaleString("th-TH", {
        timeZone: "Asia/Bangkok",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }) + " (ICT)"
    );
  } catch {
    return iso;
  }
}
