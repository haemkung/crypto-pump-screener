#!/usr/bin/env bash
# Token-free local replacement for the AI routines.
# Every 5 min (minute%5==4): check-now-alerts + evaluate-alert-outcomes.
# Every 5 min (minute%5==1): scripts/start-all.sh --quiet (idempotent; keeps the watchdog alive —
#   the watchdog in turn keeps this scheduler, Next, tunnel and the early daemon alive, and owns
#   the Telegram health warnings).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
LOG="$ROOT/logs/local-scheduler.log"
last=""
while true; do
  m=$(date +%M); m=$((10#$m)); stamp=$(date +%Y%m%d%H%M)
  if [[ "$stamp" != "$last" ]]; then
    last="$stamp"
    if (( m % 5 == 4 )); then
      { echo "== $(date -Iseconds) now-alerts"; timeout 240 node scripts/check-now-alerts.mjs; echo "exit=$?"; } >>"$LOG" 2>&1
      { echo "== $(date -Iseconds) evaluate"; timeout 240 node scripts/evaluate-alert-outcomes.mjs; echo "exit=$?"; } >>"$LOG" 2>&1
    fi
    if (( m % 5 == 1 )); then
      timeout 60 bash scripts/start-all.sh --quiet >>"$LOG" 2>&1
    fi
    # keep log small
    if [[ $(stat -c %s "$LOG" 2>/dev/null || echo 0) -gt 5000000 ]]; then tail -c 1000000 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"; fi
  fi
  sleep 20
done
