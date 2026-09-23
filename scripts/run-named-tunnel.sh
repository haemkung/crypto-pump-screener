#!/usr/bin/env bash
# Named Cloudflare Tunnel → local Next on :3000 (Workers VPC BOT_UPSTREAM).
# Token from Cloudflare API create; do not commit real token to git if public.
set -euo pipefail
TOKEN_FILE="${TUNNEL_TOKEN_FILE:-/workspace/crypto-pump-screener/.tunnel-token}"
if [[ ! -f "$TOKEN_FILE" ]]; then
  echo "Missing $TOKEN_FILE" >&2
  exit 1
fi
exec /tmp/cloudflared tunnel --no-autoupdate run --token "$(cat "$TOKEN_FILE")"
