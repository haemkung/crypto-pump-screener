/**
 * Static catalyst tags for known historical / notable cases only.
 * v1 cannot scrape news — these are hand-curated notes for educational demos.
 */
export const CATALYST_NOTES: Record<string, string> = {
  AKEUSDT: "เคสตัวอย่าง: listing / narrative pump (อดีต)",
  LSKUSDT: "เคสตัวอย่าง: ecosystem / partnership narrative (อดีต)",
  BTWUSDT: "เคสตัวอย่าง: low-float / thin liquidity narrative (อดีต)",
  USELESSUSDT: "เคสตัวอย่าง: meme / social narrative (อดีต)",
  // 龙虾 = Lobster; Binance may list as LOBSTER or similar — keep alias notes
  LOBSTERUSDT: "เคสตัวอย่าง: 龙虾 meme narrative (อดีต)",
  LONGUSDT: "เคสตัวอย่าง: 龙虾 / meme alias check (อดีต)",
};

export function getCatalystNote(symbol: string): string | undefined {
  return CATALYST_NOTES[symbol.toUpperCase()];
}
