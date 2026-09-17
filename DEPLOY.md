# Permanent deploy (Cloudflare Workers via GitHub)

ลิงก์ trycloudflare เปลี่ยนทุกครั้งที่รีสตาร์ท — วิธีนี้ได้ URL ถาวรจาก GitHub

## One-time setup

1. สมัคร [Cloudflare](https://dash.cloudflare.com/sign-up) (ฟรีได้)
2. สร้าง API Token: **Workers Scripts Edit** + **Account Settings Read**
3. เอา Account ID จากหน้า Overview
4. ใส่ GitHub Secrets ของ repo `haemkung/crypto-pump-screener`:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
5. Push ไป `main` หรือรัน workflow **Deploy Cloudflare Workers**

หลัง deploy สำเร็จ URL จะประมาณ:
`https://crypto-pump-screener.<your-subdomain>.workers.dev`

## หมายเหตุ

- Telegram แจ้งเตือน + เรียนรู้ยังรันบนเครื่อง Grok Bot (ไม่ย้ายไป Cloudflare)
- สถิติเรียนรู้บนเว็บถาวรอาจว่างจนกว่าจะ sync ข้อมูล — สกรีนเนอร์สดจาก Binance ใช้ได้ปกติ
- **ไม่ใช้ Vercel** (มือถือจอดำในไทย)
