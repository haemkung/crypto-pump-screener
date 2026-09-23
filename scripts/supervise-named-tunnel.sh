#!/usr/bin/env bash
set -euo pipefail
TOKEN_FILE="${TUNNEL_TOKEN_FILE:-/workspace/crypto-pump-screener/.tunnel-token}"
CF="${CLOUDFLARED_BIN:-/tmp/cloudflared}"
export TUNNEL_TOKEN
TUNNEL_TOKEN="$(cat "$TOKEN_FILE")"
while true; do
  echo "[$(date -Iseconds)] starting named tunnel crypto-pump-bot"
  "$CF" tunnel --no-autoupdate run --token "$TUNNEL_TOKEN" || true
  echo "[$(date -Iseconds)] tunnel exited; restart in 3s"
  sleep 3
done
