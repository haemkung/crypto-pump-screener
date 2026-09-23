# Permanent deploy (Cloudflare Workers + GitHub Pages)

ลิงก์ trycloudflare เปลี่ยนทุกครั้งที่รีสตาร์ท — วิธีนี้ได้ URL ถาวรจาก GitHub

## Permanent URLs

| Role | URL |
|------|-----|
| **GitHub Pages UI (recommended / ไม่พัง HTML)** | `https://haemkung.github.io/crypto-pump-screener/` |
| Cloudflare Workers (full Next UI + API) | `https://crypto-pump-screener.jakahome2.workers.dev` |
| Local bot upstream | `http://127.0.0.1:3000` |

GitHub Pages hosts a **static HTML shell** under `docs/` (like [ezcrypto](https://haemkung.github.io/ezcrypto/)).  
It never shows Cloudflare plain-text `Internal Server Error`. Data still comes from the Workers `/api/*` (CORS enabled for `*.github.io`).

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
