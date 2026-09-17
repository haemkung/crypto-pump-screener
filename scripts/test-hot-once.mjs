/**
 * One-shot smoke for buildHot — run: npx tsx scripts/test-hot-once.mjs
 */
import { buildHot } from "../src/lib/hot.ts";

const d = await buildHot({ forceRefresh: true });
console.log(
  JSON.stringify(
    {
      n: d.hot.length,
      late: d.late.length,
      enriched: d.meta.enriched1h,
      warnings: d.meta.warnings,
      top: d.hot.slice(0, 12).map((h) => ({
        s: h.baseAsset,
        h1: h.pct1h,
        h15: h.pct15m,
        d24: h.pct24h,
      })),
      lateTop: d.late.slice(0, 6).map((h) => ({ s: h.baseAsset, d24: h.pct24h })),
    },
    null,
    2
  )
);
