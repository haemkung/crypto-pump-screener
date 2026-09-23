#!/usr/bin/env bash
# Verify local BOT_UPSTREAM (:3000 /api/screen) and optionally Workers via VPC path.
# Exit 0 only if local screen is HTTP 200 with rows. Workers check is best-effort.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${UPSTREAM_NEXT_PORT:-3000}"
LOCAL_URL="${UPSTREAM_HEALTH_URL:-http://127.0.0.1:${PORT}/api/screen}"
WORKERS_URL="${WORKERS_HEALTH_URL:-https://crypto-pump-screener.jakahome2.workers.dev/api/screen}"
STATUS_FILE="${BOT_UPSTREAM_STATUS:-$ROOT/logs/bot-upstream/status.json}"
CHECK_WORKERS="${CHECK_WORKERS:-1}"

ok=1

echo "== bot-upstream health $(date -Iseconds) =="

if [[ -f "$STATUS_FILE" ]]; then
  echo "-- supervisor status --"
  cat "$STATUS_FILE"
  echo
else
  echo "supervisor status: missing ($STATUS_FILE)"
fi

tunnel_pids="$(pgrep -f 'cloudflared tunnel .* run --token' 2>/dev/null || true)"
if [[ -n "$tunnel_pids" ]]; then
  echo "tunnel: RUNNING pids=$tunnel_pids"
else
  echo "tunnel: DOWN"
  ok=0
fi

code="$(curl -sS -o /tmp/bot-upstream-local-screen.json -w '%{http_code}' --max-time 20 "$LOCAL_URL" || echo 000)"
rows="$(python3 - <<'PY'
import json
try:
  d=json.load(open("/tmp/bot-upstream-local-screen.json"))
  rows=d.get("rows") or d.get("results") or []
  print(len(rows) if isinstance(rows,list) else 0)
except Exception:
  print(0)
PY
)"
echo "local /api/screen: HTTP $code rows=$rows"
if [[ "$code" != "200" || "$rows" -lt 1 ]]; then
  ok=0
fi

if [[ "$CHECK_WORKERS" == "1" ]]; then
  wcode="$(curl -sS -o /tmp/bot-upstream-workers-screen.json -w '%{http_code}' --max-time 25 "$WORKERS_URL" || echo 000)"
  wrows="$(python3 - <<'PY'
import json
try:
  d=json.load(open("/tmp/bot-upstream-workers-screen.json"))
  rows=d.get("rows") or d.get("results") or []
  print(len(rows) if isinstance(rows,list) else 0)
except Exception:
  print(0)
PY
)"
  via="$(python3 - <<'PY'
import json
try:
  # header not here; peek meta if any
  d=json.load(open("/tmp/bot-upstream-workers-screen.json"))
  print(d.get("meta",{}).get("via","") if isinstance(d.get("meta"),dict) else "")
except Exception:
  print("")
PY
)"
  echo "workers /api/screen: HTTP $wcode rows=$wrows"
fi

# supervisor process
if pgrep -f 'supervise-bot-upstream.sh|supervise-named-tunnel.sh' >/dev/null 2>&1; then
  echo "supervisor: RUNNING"
else
  echo "supervisor: DOWN"
  ok=0
fi

if [[ "$ok" -eq 1 ]]; then
  echo "RESULT: OK"
  exit 0
fi
echo "RESULT: FAIL"
exit 1
