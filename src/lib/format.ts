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
    // short-side
    early_drop: "Early Drop",
    late_short_chase: "Late Short",
    positive_funding: "Funding+",
    long_squeeze_fuel: "Long Squeeze",
    mtf_align: "MTF✓",
    mtf_mixed: "MTF~",
    mtf_against: "MTF✗",
    false_pattern_risk: "FalsePat",
  };
  return map[flag] || flag;
}

export function qualityBadgeClass(grade: string | null | undefined): string {
  switch (grade ?? "C") {
    case "A":
      return "bg-emerald-500 text-black";
    case "B":
      return "bg-sky-500 text-black";
    case "C":
      return "bg-zinc-600 text-zinc-100";
    default:
      return "bg-zinc-800 text-zinc-400";
  }
}

export function regimeChipClass(kind: string): string {
  switch (kind) {
    case "risk_on":
      return "bg-emerald-950 text-emerald-300 ring-emerald-700";
    case "risk_off":
      return "bg-rose-950 text-rose-300 ring-rose-700";
    default:
      return "bg-zinc-800 text-zinc-300 ring-zinc-600";
  }
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

export function entryModeLabelTh(mode: string): string {
  const map: Record<string, string> = {
    early_entry: "ต้นทาง",
    wait_pullback: "รอพัก",
    too_late: "สายแล้ว",
    watch_only: "เฝ้าดู",
    early_short: "ต้นทาง Short",
    wait_bounce: "รอเด้งก่อน Short",
    too_late_short: "ลงลึกแล้ว",
    watch_only_short: "เฝ้าดู",
  };
  return map[mode] || mode;
}

export function entryModeBadgeClass(mode: string): string {
  switch (mode) {
    case "early_entry":
    case "early_short":
      return "bg-emerald-950 text-emerald-300 ring-emerald-700";
    case "wait_pullback":
    case "wait_bounce":
      return "bg-amber-950 text-amber-300 ring-amber-700";
    case "too_late":
    case "too_late_short":
      return "bg-rose-950 text-rose-300 ring-rose-800";
    default:
      return "bg-zinc-800 text-zinc-400 ring-zinc-700";
  }
}
