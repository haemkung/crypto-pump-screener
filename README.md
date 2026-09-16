# Crypto Pump Pattern Screener

Thai-friendly dark dashboard that screens **Binance USDⓈ-M Futures** for a heuristic 4-leg pump pattern.

**ไม่ใช่คำแนะนำการลงทุน / Not financial advice.**

---

## How to run / วิธีรัน

```bash
cd /workspace/crypto-pump-screener
npm install
npm run dev
```

Then open: **http://localhost:3000**

Production-style:

```bash
npm run build && npm run start
```

Bind all interfaces (if needed):

```bash
npx next dev -H 0.0.0.0 -p 3000
```

---

## What PatternScore means / ความหมายคะแนน

`PatternScore` is **0–100**, computed only from fields that Binance actually returns. Missing data contributes **0** and is noted in the detail panel — we never invent numbers.

| Component | ~Weight | Logic |
|-----------|---------|--------|
| Early move | ~25 | 24h % in ~5–25% gets a bonus; **>50%** gets a `late_chase` flag (penalty tag) |
| Volume | ~30 | `quoteVolume` percentile among USDT perps |
| Funding | ~20 | Negative `lastFundingRate` = short fuel / squeeze setup |
| Liquidity | ~15 | High futures/spot volume ratio; or **No Spot** thin-liquidity flag |
| OI change | ~10 | % change over recent OI hist (top volume symbols only) |

**Flags** (labels): `early_move`, `late_chase`, `neg_funding`, `short_squeeze_fuel`, `thin_liquidity`, `no_spot`, `high_volume`, `oi_rising`, `catalyst`.

Catalyst notes are **static** for a few known historical tickers only — v1 cannot scrape news.

---

## Data sources / แหล่งข้อมูล

Public Binance APIs via **server-side Next.js routes** (avoids browser CORS):

| Route | Upstream |
|-------|----------|
| `/api/proxy/futures/ticker24hr` | `fapi.binance.com/fapi/v1/ticker/24hr` |
| `/api/proxy/futures/premiumIndex` | `fapi.binance.com/fapi/v1/premiumIndex` |
| `/api/proxy/futures/openInterest?symbol=` | `fapi/v1/openInterest` |
| `/api/proxy/futures/openInterestHist?symbol=&period=` | `futures/data/openInterestHist` |
| `/api/proxy/futures/globalLongShortAccountRatio?symbol=` | `futures/data/globalLongShortAccountRatio` |
| `/api/proxy/futures/topLongShortPositionRatio?symbol=` | `futures/data/topLongShortPositionRatio` |
| `/api/proxy/futures/takerlongshortRatio?symbol=` | `futures/data/takerlongshortRatio` |
| `/api/proxy/spot/ticker24hr` | `api.binance.com/api/v3/ticker/24hr` |
| `/api/screen` | Aggregated screen + scores |
| `/api/oi-detail?symbol=` | Lazy OI + L/S for one row |

Filter: USDT perpetual pairs ending in `USDT` (excludes dated quarterlies with `_`).

---

## Rate limits & caching / จำกัดเรท

- Server cache ~**45–60s** for bulk tickers / screen payload.
- OI history is fetched only for the **top ~50** symbols by futures quote volume (batched, staggered).
- Detail panel lazy-loads L/S ratios per selected symbol.
- UI auto-refreshes about every **50s**.

---

## UI features

- Dark crypto dashboard, **Thai labels primary**
- Table sorted by score: Symbol, Price, 24h%, Vol, Funding, Fut/Spot, Score, Flags
- Filters: min volume, min score, hide late pumps
- Detail panel with score breakdown + lazy OI/L/S
- Section **เคสตัวอย่างในอดีต**: AKE, LSK, BTW, USELESS, 龙虾

---

## Limitations / ข้อจำกัด

1. Heuristic only — not a trading system or signal service.
2. No news scraping; catalyst tags are static examples.
3. Spot ratio only when the same `SYMBOLUSDT` exists on Binance spot.
4. Some L/S or OI endpoints may fail intermittently (rate limit / geo); those fields stay empty.
5. Scores can change as cache refreshes; do not treat as real-time fills.

---

## Stack

Next.js 15 (App Router) · TypeScript · Tailwind CSS 4 · npm

## Environment note (this machine)

Some cloud IPs (e.g. US AWS) get HTTP **451** from `fapi.binance.com` / `api.binance.com`.
This app automatically falls back to `https://www.binance.com` (same REST paths) and
`https://data-api.binance.vision` for spot. If spot is temporarily rate-banned (418),
Fut/Spot ratios are omitted until the ban lifts — rows are **not** mass-tagged as No Spot.
