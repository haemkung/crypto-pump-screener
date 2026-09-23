# Permanent deploy (Cloudflare Workers via GitHub)

ลิงก์ trycloudflare เปลี่ยนทุกครั้งที่รีสตาร์ท — วิธีนี้ได้ URL ถาวรจาก GitHub

Live: `https://crypto-pump-screener.jakahome2.workers.dev`

## Architecture (important)

- **Workers** serves the public UI. Binance often **403** from Cloudflare edge IPs, so read APIs prefer **VPC `BOT_UPSTREAM`** → named Cloudflare Tunnel → local Next on `:3000`.
- If the tunnel/VPC returns **5xx**, Workers **falls through** and tries to handle the request locally (Binance multi-host / empty learning) instead of poisoning the UI with HTTP 500.
- **Telegram alerts + learning writes** still run on the Grok Bot machine (`DISABLE_BOT_UPSTREAM=1 BOT_ROLE=upstream` on local Next).

## Keep the named tunnel up (required for live screen rows)

```bash
# one-time: cloudflared binary
curl -fsSL -o /tmp/cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x /tmp/cloudflared

# token is local-only (.tunnel-token, gitignored)
bash scripts/supervise-named-tunnel.sh
```

Local Next must be listening on `127.0.0.1:3000` with:

```bash
DISABLE_BOT_UPSTREAM=1 BOT_ROLE=upstream npm run dev
# or: npm start after build
```

## One-time Cloudflare + GitHub setup

1. สมัคร [Cloudflare](https://dash.cloudflare.com/sign-up) (ฟรีได้)
2. สร้าง API Token: **Workers Scripts Edit** + **Account Settings Read**
3. เอา Account ID จากหน้า Overview
4. ใส่ GitHub Secrets ของ repo `haemkung/crypto-pump-screener`:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
5. Push ไป `main` หรือรัน `npm run deploy` (OpenNext + wrangler)

## หมายเหตุ

- สถิติเรียนรู้บนเว็บถาวร sync ผ่าน tunnel; ถ้า tunnel ลง API จะไม่ 500 แต่เคสอาจว่างชั่วคราว
- **ไม่ใช้ Vercel** (มือถือจอดำในไทย)
