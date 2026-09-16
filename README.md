# Crypto Pump / Dump Pattern Screener

Thai-friendly dark dashboard that screens **Binance USDⓈ-M Futures** for heuristic **Long (ขาขึ้น)** and **Short (ขาลง)** patterns in two separate tabs.

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

## Modes / โหมด

| Tab | Thai | Sort | Score field |
|-----|------|------|-------------|
| **Long** (default) | ขาขึ้น | `score` desc | PatternScore / pump |
| **Short** | ขาลง | `shortScore` desc | ShortScore / dump |

Long behavior is unchanged. Short uses independent flags, breakdown, and entry hints.

---

## What PatternScore means / คะแนน Long

`PatternScore` is **0–100**, computed only from fields that Binance actually returns. Missing data contributes **0** and is noted in the detail panel — we never invent numbers.

| Component | ~Weight | Logic |
|-----------|---------|--------|
| Early move | ~25 | 24h % in ~5–25% gets a bonus; **>50%** gets a `late_chase` flag |
| Volume | ~30 | `quoteVolume` percentile among USDT perps |
| Funding | ~20 | Negative `lastFundingRate` = short fuel / squeeze setup |
| Liquidity | ~15 | High futures/spot volume ratio; or **No Spot** thin-liquidity flag |
| OI change | ~10 | % change over recent OI hist (top volume symbols only) |

**Flags**: `early_move`, `late_chase`, `neg_funding`, `short_squeeze_fuel`, `thin_liquidity`, `no_spot`, `high_volume`, `oi_rising`, `catalyst`.

---

## What ShortScore means / คะแนน Short

`ShortScore` is **0–100**, independent of PatternScore. Favors early downside + crowded longs.

| Component | ~Weight | Logic |
|-----------|---------|--------|
| Early drop | ~25 | 24h % in **~−5% to −20%**; **&lt; −35%** → `late_short_chase`; **&lt; −50%** clearly too late |
| Volume | ~30 | Same volume percentile |
| Funding | ~20 | **Positive** `lastFundingRate` = crowded longs / `long_squeeze_fuel` |
| Liquidity | ~15 | High fut/spot or No Spot |
| OI change | ~10 | Rising OI when available |

**Short flags**: `early_drop`, `late_short_chase`, `positive_funding`, `long_squeeze_fuel`, `thin_liquidity`, `no_spot`, `high_volume`, `oi_rising`, `catalyst`.

**Warning (TH):** ขา Short อาจเด้งแรง / long squeeze ได้ — เป็น heuristic สำหรับวิจัย ไม่ใช่คำสั่งเทรด.

---

## Entry-zone hints / จุดเข้า (heuristic)

### Long — `entry` from `computeEntryHint`

| Mode | Badge | When |
|------|-------|------|
| `early_entry` | ต้นทาง | early_move / 24h ~5–18%, preferably neg funding; band ≈ −1.5% … +0.5% |
| `wait_pullback` | รอพัก | 24h ~18–40%; pullback band under last |
| `too_late` | สายแล้ว | late_chase / &gt;50% — no band |
| `watch_only` | เฝ้าดู | Mixed / weak |

Invalidation: **below** entry zone (or funding flips deeply positive while price dumps).

### Short — `shortEntry` from `computeShortEntryHint`

| Mode | Badge | When |
|------|-------|------|
| `early_short` | ต้นทาง Short | early_drop / 24h ~−5…−20%, preferably funding+; band near last / small bounce |
| `wait_bounce` | รอเด้งก่อน Short | 24h ~−20…−35%; band **above** current |
| `too_late_short` | ลงลึกแล้ว | late_short_chase / &lt;−50% — no band, ไม่ไล่ Short |
| `watch_only_short` | เฝ้าดู | Mixed / weak |

Invalidation: **above** entry zone (or funding flips strongly negative while price rebounds).

Disclaimer under entry: *จุดเข้า/จุด Short เป็น heuristic จากแพทเทิร์น ไม่ใช่คำสั่งซื้อ/ขาย*.

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
| `/api/screen` | Aggregated screen + long/short scores |
| `/api/oi-detail?symbol=` | Lazy OI + L/S for one row |

Filter: USDT perpetual pairs ending in `USDT` (excludes dated quarterlies with `_`).

---

## Rate limits & caching / จำกัดเรท

- Server cache ~**45–60s** for bulk tickers / screen payload (`screen:v4`).
- `/api/screen` defaults to **oiTop=0** (fast path). Pass `?oiTop=40` to enrich OI for top-N by volume. Client lazy-enriches after first paint.
- UI shows **top 80** rows by the **active mode’s score**, with **โหลดเพิ่ม** / page-size control (does not mount all ~700 rows).
- Detail panel lazy-loads L/S ratios per selected symbol and shows long or short breakdown based on tab.
- UI auto-refreshes about every **50s** (stale-while-revalidate).

---

## UI features

- Dark crypto dashboard, **Thai labels primary**
- Tabs: **Long (ขาขึ้น)** / **Short (ขาลง)**
- Long columns: Symbol, Price, 24h%, Vol, Funding, Fut/Spot, Score, จุดเข้า, Flags
- Short columns: Symbol, Price, 24h%, Vol, Funding, Short Score, จุด Short, Flags
- Filters: min volume, min score, hide late (chase / late short)
- Detail panel mode-aware: score breakdown + entry/invalidation + lazy OI/L/S
- Section **เคสตัวอย่างในอดีต** (Long tab): AKE, LSK, BTW, USELESS, 龙虾

---

## Limitations / ข้อจำกัด

1. Heuristic only — not a trading system or signal service.
2. No news scraping; catalyst tags are static examples.
3. Spot ratio only when the same `SYMBOLUSDT` exists on Binance spot.
4. Some L/S or OI endpoints may fail intermittently (rate limit / geo); those fields stay empty.
5. Scores can change as cache refreshes; do not treat as real-time fills.
6. Short side can rebound violently / squeeze — never chase deep dumps.

---

## Stack

Next.js 15 (App Router) · TypeScript · Tailwind CSS 4 · npm

## Environment note (this machine)

Some cloud IPs (e.g. US AWS) get HTTP **451** from `fapi.binance.com` / `api.binance.com`.
This app automatically falls back to `https://www.binance.com` (same REST paths) and
`https://data-api.binance.vision` for spot. If spot is temporarily rate-banned (418),
Fut/Spot ratios are omitted until the ban lifts — rows are **not** mass-tagged as No Spot.
