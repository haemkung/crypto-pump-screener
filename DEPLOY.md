# Permanent deploy (Cloudflare Workers via GitHub)

ลิงก์ trycloudflare เปลี่ยนทุกครั้งที่รีสตาร์ท — วิธีนี้ได้ URL ถาวรจาก GitHub

Live: `https://crypto-pump-screener.jakahome2.workers.dev`

## Architecture (important)

- **Workers** serves the public UI. Binance often **403** from Cloudflare edge IPs, so read APIs prefer **VPC `BOT_UPSTREAM`** → named Cloudflare Tunnel → local Next on `:3000`.
- If the tunnel/VPC returns **5xx**, Workers **falls through** and tries to handle the request locally (Binance multi-host / empty learning) instead of poisoning the UI with HTTP 500.
- If both upstream and local Binance fail briefly, `/api/screen` (and `/api/hot`) may return the **last good real payload** for a few minutes (`X-Screen-Stale: 1`) — never invented rows.
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

# or legacy name (same dual supervisor):
# nohup bash scripts/supervise-named-tunnel.sh &
```

What it does:

1. Starts / adopts **named Cloudflare tunnel** → `http://127.0.0.1:3000`
2. Starts / adopts **local Next** with `DISABLE_BOT_UPSTREAM=1 BOT_ROLE=upstream`
3. Polls `http://127.0.0.1:3000/api/screen` every ~8s; after 3 failures, **restarts Next**
4. If `cloudflared` dies, **restarts tunnel**
5. Writes status to:
   - `logs/bot-upstream/status.json`
   - `/tmp/crypto-pump-bot-upstream-status.json`
6. Logs: `logs/bot-upstream/supervisor.log`, `next.log`, `tunnel.log` (mirrored under `/tmp/crypto-pump-bot-upstream/`)

### Health check

```bash
bash scripts/health-bot-upstream.sh
# local only:
CHECK_WORKERS=0 bash scripts/health-bot-upstream.sh

curl -sS http://127.0.0.1:3000/api/health | jq .
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/screen
curl -sS -o /dev/null -w '%{http_code}\n' https://crypto-pump-screener.jakahome2.workers.dev/api/screen
```

### Recovery (if something still looks down)

```bash
# 1) Inspect status
cat logs/bot-upstream/status.json
tail -n 80 logs/bot-upstream/supervisor.log

# 2) Ensure only one supervisor (flock), then restart it
pkill -f supervise-bot-upstream.sh || true
pkill -f 'cloudflared tunnel .* run --token' || true
# leave Next if healthy; supervisor will adopt or restart
nohup bash scripts/supervise-bot-upstream.sh >> logs/bot-upstream/nohup.out 2>&1 &

# 3) Hard Next restart (Telegram scripts need :3000)
pkill -f 'next dev -H 0.0.0.0 -p 3000' || true
# supervisor will bring it back within one poll cycle, or:
DISABLE_BOT_UPSTREAM=1 BOT_ROLE=upstream npm run dev
```

Telegram alert scripts (`npm run check-now-alerts`, etc.) continue to hit **local** `:3000` — keep the supervisor running on the bot box.

## One-time Cloudflare + GitHub setup

1. สมัคร [Cloudflare](https://dash.cloudflare.com/sign-up) (ฟรีได้)
2. สร้าง API Token: **Workers Scripts Edit** + **Account Settings Read**
3. เอา Account ID จากหน้า Overview
4. ใส่ GitHub Secrets ของ repo `haemkung/crypto-pump-screener`:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
5. Push ไป `main` หรือรัน `npm run deploy` (OpenNext + wrangler)

## หมายเหตุ

- สถิติเรียนรู้บนเว็บถาวร sync ผ่าน tunnel; ถ้า tunnel ลง API จะไม่ 500 แต่เคสอาจว่างชั่วคราว (หรือ stale screen สั้นๆ)
- **ไม่ใช้ Vercel** (มือถือจอดำในไทย)
- Remaining SPOFs: this bot machine itself, Cloudflare tunnel account/token, VPC service binding — supervisor removes process-crash SPOF for tunnel+Next only.
