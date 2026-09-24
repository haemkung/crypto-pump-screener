# Permanent deploy (Cloudflare Workers + GitHub Pages)

ลิงก์ trycloudflare เปลี่ยนทุกครั้งที่รีสตาร์ท — วิธีนี้ได้ URL ถาวรจาก GitHub

## Permanent URLs

| Role | URL |
|------|-----|
| **GitHub Pages UI (recommended / ไม่พัง HTML)** | `https://haemkung.github.io/crypto-pump-screener/` |
| Cloudflare Workers (full Next UI + API) | `https://crypto-pump-screener.jakahome2.workers.dev` |
| Local bot upstream | `http://127.0.0.1:3000` |

GitHub Pages hosts a **full React SPA** under `docs/` (Vite build of the same `src/components` as Workers).  
It never shows Cloudflare plain-text `Internal Server Error`. Data still comes from the Workers `/api/*` (CORS enabled for `*.github.io`).

Rebuild Pages UI after UI changes:

```bash
npm run pages:build   # writes into docs/ (base /crypto-pump-screener/)
git add docs && git commit -m "…" && git push
```

## Architecture (important)

- **Workers** serves the full Next UI + API. Binance often **403** from Cloudflare edge IPs, so read APIs prefer **VPC `BOT_UPSTREAM`** → named Cloudflare Tunnel → local Next on `:3000`.
- VPC responses are **streamed** (not `res.text()` / `JSON.parse` on the edge). Buffering `/api/screen` (~1.5MB) previously caused **Error 1102** (CPU/memory) → HTTP 503.
- If the tunnel/VPC returns **5xx / timeout**, Workers **falls through**. On Workers, heavy `buildScreen` is **skipped** (also 1102); serve **last-good** or soft JSON 503 — never invent rows, never crash the isolate with a huge local compute path.
- Home `/` keeps Screener **client-only** (`next/dynamic` `ssr:false`) so the server page shell stays tiny (large RSC graphs also caused 1102 / blank ISE).
- **Telegram alerts + learning writes** still run on the Grok Bot machine (`DISABLE_BOT_UPSTREAM=1 BOT_ROLE=upstream` on local Next).

## Permanence: dual supervisor (tunnel + Next)

Single fragile tunnel process is not enough. Use the dual supervisor so **both** named `cloudflared` **and** local Next stay up with auto-restart + health polling.

```bash
cd /workspace/crypto-pump-screener

# one-time: cloudflared binary
curl -fsSL -o /tmp/cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x /tmp/cloudflared

# token is local-only (.tunnel-token, gitignored)
# keeps tunnel + Next alive; flock single-instance; logs under logs/bot-upstream/
nohup bash scripts/supervise-bot-upstream.sh >> logs/bot-upstream/nohup.out 2>&1 &
```

### Health check

```bash
bash scripts/health-bot-upstream.sh
CHECK_WORKERS=0 bash scripts/health-bot-upstream.sh

curl -sS http://127.0.0.1:3000/api/health | jq .
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/screen
curl -sS -o /dev/null -w '%{http_code}\n' https://crypto-pump-screener.jakahome2.workers.dev/api/screen
curl -sS -o /dev/null -w '%{http_code}\n' https://haemkung.github.io/crypto-pump-screener/
```

## Early tiers daemon (เริ่มขยับ / เริ่มทุบ / กำลังสะสม / กำลังแจกของ)

`scripts/early-ignition-daemon.mjs` runs **locally only** (never on Workers) and is started + auto-restarted by
`scripts/supervise-bot-upstream.sh` (`ensure_early` every poll; disable with `EARLY_IGNITION_ENABLED=0`).
Start the supervisor from a shell that has `TELEGRAM_BOT_TOKEN` exported (the daemon inherits it; chat id from `.telegram-chat-id`).

- **Confluence-first** (price move alone never alerts). Ignition (every ~60s): price breakout is only the timing trigger;
  it must be preceded by >=3 independent evidence factors (OI build while flat, funding against the crowd, crowded L/S,
  taker imbalance, quiet volume inflow, spot leading, fade-after-pump for Short). Watch (every 5 min): OI build + >=3 factors (>=2 directional).
- Every row lists each reason with its number. Web: daemon writes `data/early-tiers.json` → `GET /api/early-tiers`
  (Workers proxies BOT_UPSTREAM pass-through, CORS for Pages) → `EarlyTiersPanel` section on Workers + Pages.
- Backtest: `npm run early:fetch-bt -- --out /tmp/early-bt` then `npm run early:backtest-confluence -- --data /tmp/early-bt --windows "k:<ISO end>"`.
- Telegram switches: `data/early-alert-settings.json` (`sendIgnitionLong`, `sendIgnitionShort`, `sendWatchLong`, `sendWatchShort`).
  Short tiers ship **off**; suppressed signals are still logged + graded.
- Log / self-grading: `data/early-alerts.json` (5m/15m/60m + path rule; kept separate from `alert-log.json` so the main learning weights are untouched).
  Dedupe state `.early-alert-state.json`; daemon log + status under `logs/early-ignition/`.

```bash
npm run early:dry                         # one dry-run cycle, no Telegram, no state writes
tail -f logs/early-ignition/daemon.log
cat logs/early-ignition/status.json | jq .
npm run early:backtest -- --cache /tmp/k1m --hours 24 --symbols QNTUSDT,BTCUSDT
```

## GitHub Pages

Source: branch `main`, folder `/docs`.

```bash
# enable (once)
gh api -X POST repos/haemkung/crypto-pump-screener/pages \
  -f build_type=legacy \
  -f 'source[branch]=main' \
  -f 'source[path]=/docs'

# or update
gh api -X PUT repos/haemkung/crypto-pump-screener/pages \
  -f build_type=legacy \
  -f 'source[branch]=main' \
  -f 'source[path]=/docs'
```

Override API from the static UI: `?api=https://crypto-pump-screener.jakahome2.workers.dev`

## One-time Cloudflare + GitHub setup

1. สมัคร [Cloudflare](https://dash.cloudflare.com/sign-up) (ฟรีได้)
2. สร้าง API Token: **Workers Scripts Edit** + **Account Settings Read**
3. เอา Account ID จากหน้า Overview
4. ใส่ GitHub Secrets ของ repo `haemkung/crypto-pump-screener`:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
5. Push ไป `main` หรือรัน `npm run deploy` (OpenNext + wrangler)

## หมายเหตุ

- สถิติเรียนรู้บนเว็บถาวร sync ผ่าน tunnel; ถ้า tunnel ลง API จะ soft-fail / stale ไม่ 1102
- **ไม่ใช้ Vercel** (มือถือจอดำในไทย)
- Remaining SPOFs: bot machine itself, Cloudflare tunnel account/token, VPC binding, Workers API for live data (Pages HTML stays up regardless)

## Early tiers v3 — walk-forward validated, tight-stop risk model (2026-09)

- Data cache (not committed): `node scripts/fetch-early-backtest-30d.mjs --out /workspace/cache/early-bt-30d`
  (top-250 perps by volume ∪ >15% daily-range movers; 1m klines, 5m spot, funding, 15m OI / global L/S / top-trader L/S / taker).
  Shard with `--lanes fapi|data --shard i/n`; resumable.
- Validation: `node scripts/walkforward-early.mjs --data /workspace/cache/early-bt-30d` → tunes a coarse grid on the first 20 days,
  freezes it, scores the rest out-of-sample, writes `data/early-tier-config.json` (frozen params + OOS stats + verdict, read live by the daemon).
- Risk model (user rule, high leverage): structural SL, floor 0.6%, cap 2.5%, **skip if structure needs >3%** (web shows "SL กว้างเกิน");
  TP1 1.5R (close half, SL→breakeven), TP2 3R; fill = next bar open; 0.1% round-trip cost. Same code (`structuralStop`, `simulateTrade`
  in `scripts/lib/early-ignition-core.mjs`) grades the backtest and every live alert (`a.trade` in `data/early-alerts.json`, 12h after the alert).
- Telegram per tier: `data/early-alert-settings.json` (`sendIgnitionLong/Short`, `sendWatchLong/Short`, daily caps) — only tiers whose OOS
  result clearly beat price-only and random entry are switched on.
- Replay a coin: `node scripts/replay-symbol-early.mjs --symbol QNTUSDT --from ... --to ...`.

## Always-on ("ห้ามล่ม")

- `bash scripts/start-all.sh` — idempotent boot. Starts (if missing) `scripts/watchdog.sh`, `supervise-bot-upstream.sh`
  (Next :3000 + cloudflared + early daemon) and `supervise-local-scheduler.sh`. Installs `@reboot` cron when crontab exists.
- `scripts/watchdog.sh` (flock single instance, 30s loop): restarts missing supervisors with exponential backoff (60s→10min), kills a
  hung early daemon (heartbeat `logs/early-ignition/status.json` older than 5 min) so the supervisor restarts it, checks local
  `/api/early-tiers` and the public Workers URL (every 5 min). Telegram warning only after sustained failure (e.g. public down 15 min,
  Next down ~5 min), max once per 2h per problem, plus one recovery message. Status: `logs/watchdog-status.json`.
- `scripts/local-scheduler.sh` re-runs `start-all.sh --quiet` every 5 min, so watchdog and scheduler supervise each other.
- Workers `/api/early-tiers` serves the last good snapshot (header `X-Early-Tiers-Stale: 1`) if the upstream is down; the web panel
  also keeps a localStorage copy and shows "แสดงข้อมูลล่าสุดที่มี (อัปเดต …)".
