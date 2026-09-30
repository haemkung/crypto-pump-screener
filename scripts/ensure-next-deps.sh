#!/usr/bin/env bash
# Ensure node_modules/.bin/next exists. Auto npm ci when missing.
# Safe to call from heal/supervisor/start scripts. Exits 0 when next is runnable.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
NEXT_BIN="$ROOT/node_modules/.bin/next"
LOCK="${ENSURE_NEXT_DEPS_LOCK:-/tmp/crypto-pump-ensure-next-deps.lock}"
LOG_DIR="$ROOT/logs/heal-once"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/ensure-deps.log"

log() { echo "[$(date -Iseconds)] $*" | tee -a "$LOG" >/dev/null; }

if [[ -x "$NEXT_BIN" ]]; then
  exit 0
fi

exec 9>"$LOCK"
if ! flock -n 9; then
  # Another ensure is running — wait up to 4 minutes for next to appear
  log "ensure-next-deps waiting on lock"
  for _ in $(seq 1 48); do
    [[ -x "$NEXT_BIN" ]] && exit 0
    sleep 5
  done
  log "ERROR: timed out waiting for parallel npm ci"
  exit 1
fi

if [[ -x "$NEXT_BIN" ]]; then
  exit 0
fi

if [[ ! -f "$ROOT/package-lock.json" ]]; then
  log "ERROR: package-lock.json missing — cannot npm ci"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  log "ERROR: npm not found"
  exit 1
fi

log "node_modules/.bin/next missing — running npm ci"
# Avoid infinite supervisor restart spam while install runs
if timeout 600 npm ci >>"$LOG" 2>&1; then
  if [[ -x "$NEXT_BIN" ]]; then
    log "npm ci ok — next ready"
    exit 0
  fi
  log "ERROR: npm ci finished but next still missing"
  exit 1
fi
log "ERROR: npm ci failed (see $LOG)"
exit 1
