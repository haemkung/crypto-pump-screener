#!/usr/bin/env bash
# One-shot named Cloudflare Tunnel → local Next on :3000 (Workers VPC BOT_UPSTREAM).
# Prefer supervise-bot-upstream.sh for permanence (auto-restart tunnel + Next).
# Token from Cloudflare API create; do not commit real token to git if public.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOKEN_FILE="${TUNNEL_TOKEN_FILE:-$ROOT/.tunnel-token}"
CF_BIN="${CLOUDFLARED_BIN:-/tmp/cloudflared}"
if [[ ! -f "$TOKEN_FILE" ]]; then
  echo "Missing $TOKEN_FILE" >&2
  exit 1
fi
if [[ ! -x "$CF_BIN" ]]; then
  echo "Missing executable $CF_BIN — download cloudflared or set CLOUDFLARED_BIN" >&2
  exit 1
fi
exec "$CF_BIN" tunnel --no-autoupdate run --token "$(cat "$TOKEN_FILE")"
