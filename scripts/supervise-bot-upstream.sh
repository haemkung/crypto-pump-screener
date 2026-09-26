#!/usr/bin/env bash
# Keep BOTH the named Cloudflare tunnel AND local Next (:3000 BOT_UPSTREAM) alive.
# Auto-restarts either on crash. Single-instance via flock.
# Logs + status under logs/bot-upstream/ (project) with /tmp fallback mirror.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Load local secrets (gitignored) into env for child processes — never echo values
if [[ -f "$ROOT/.env.secrets" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env.secrets"
  set +a
fi
LOG_DIR="${BOT_UPSTREAM_LOG_DIR:-$ROOT/logs/bot-upstream}"
mkdir -p "$LOG_DIR"
TMP_MIRROR="${BOT_UPSTREAM_TMP_MIRROR:-/tmp/crypto-pump-bot-upstream}"
mkdir -p "$TMP_MIRROR"

LOCK_FILE="${BOT_UPSTREAM_LOCK:-/tmp/crypto-pump-bot-upstream.lock}"
STATUS_FILE="$LOG_DIR/status.json"
STATUS_MIRROR="$TMP_MIRROR/status.json"
SUPER_LOG="$LOG_DIR/supervisor.log"
NEXT_LOG="$LOG_DIR/next.log"
TUNNEL_LOG="$LOG_DIR/tunnel.log"
NEXT_PID_FILE="$LOG_DIR/next.pid"
TUNNEL_PID_FILE="$LOG_DIR/tunnel.pid"

TOKEN_FILE="${TUNNEL_TOKEN_FILE:-$ROOT/.tunnel-token}"
CF_BIN="${CLOUDFLARED_BIN:-/tmp/cloudflared}"
NEXT_PORT="${UPSTREAM_NEXT_PORT:-3000}"
HEALTH_URL="${UPSTREAM_HEALTH_URL:-http://127.0.0.1:${NEXT_PORT}/api/screen}"
POLL_SEC="${BOT_UPSTREAM_POLL_SEC:-8}"
NEXT_FAIL_THRESHOLD="${BOT_UPSTREAM_NEXT_FAIL_THRESHOLD:-3}"
RESTART_BACKOFF_SEC="${BOT_UPSTREAM_RESTART_BACKOFF_SEC:-3}"
CF_DOWNLOAD_URL="${CLOUDFLARED_DOWNLOAD_URL:-https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64}"

# Early-ignition Telegram daemon (local Node, ~60s cycle). Set EARLY_IGNITION_ENABLED=0 to disable.
EARLY_ENABLED="${EARLY_IGNITION_ENABLED:-1}"
EARLY_LOG_DIR="$ROOT/logs/early-ignition"
EARLY_LOG="$EARLY_LOG_DIR/daemon.log"
EARLY_PID_FILE="$EARLY_LOG_DIR/daemon.pid"
EARLY_SCRIPT="$ROOT/scripts/early-ignition-daemon.mjs"
EARLY_LOG_MAX_BYTES="${EARLY_LOG_MAX_BYTES:-5000000}"
WAKE_FLAG="$EARLY_LOG_DIR/wake.flag"
EARLY_DEAD_SEC="${EARLY_DEAD_SEC:-90}"

NEXT_FAILS=0
STARTED_AT="$(date -Iseconds)"

log() {
  local line="[$(date -Iseconds)] $*"
  echo "$line" | tee -a "$SUPER_LOG" >/dev/null
  echo "$line" >>"$TMP_MIRROR/supervisor.log" 2>/dev/null || true
  echo "$line"
}

write_status() {
  local next_ok="$1" tunnel_ok="$2" screen_code="$3" note="${4:-}"
  local next_pid tunnel_pid
  next_pid="$(cat "$NEXT_PID_FILE" 2>/dev/null || echo "")"
  tunnel_pid="$(cat "$TUNNEL_PID_FILE" 2>/dev/null || echo "")"
  local payload
  payload="$(jq -nc \
    --arg updatedAt "$(date -Iseconds)" \
    --arg startedAt "$STARTED_AT" \
    --argjson nextOk "$next_ok" \
    --argjson tunnelOk "$tunnel_ok" \
    --arg screenHttp "$screen_code" \
    --arg nextPid "$next_pid" \
    --arg tunnelPid "$tunnel_pid" \
    --arg note "$note" \
    --arg healthUrl "$HEALTH_URL" \
    --arg logDir "$LOG_DIR" \
    '{updatedAt:$updatedAt,startedAt:$startedAt,nextOk:$nextOk,tunnelOk:$tunnelOk,screenHttp:$screenHttp,nextPid:$nextPid,tunnelPid:$tunnelPid,note:$note,healthUrl:$healthUrl,logDir:$logDir}')"
  printf '%s\n' "$payload" >"$STATUS_FILE"
  cp -f "$STATUS_FILE" "$STATUS_MIRROR" 2>/dev/null || true
  cp -f "$STATUS_FILE" /tmp/crypto-pump-bot-upstream-status.json 2>/dev/null || true
}

port_listening() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -tlnH "sport = :$port" 2>/dev/null | grep -q LISTEN
  else
    curl -fsS --max-time 1 "http://127.0.0.1:${port}/" >/dev/null 2>&1
  fi
}

http_code() {
  local url="$1"
  curl -sS -o /dev/null -w '%{http_code}' --max-time 12 "$url" 2>/dev/null || echo "000"
}

ensure_cloudflared() {
  if [[ -x "$CF_BIN" ]]; then
    return 0
  fi
  log "cloudflared missing at $CF_BIN — downloading"
  curl -fsSL -o "$CF_BIN" "$CF_DOWNLOAD_URL"
  chmod +x "$CF_BIN"
}

find_tunnel_pid() {
  # Prefer recorded pid if still alive and is cloudflared
  if [[ -f "$TUNNEL_PID_FILE" ]]; then
    local p
    p="$(cat "$TUNNEL_PID_FILE" 2>/dev/null || true)"
    if [[ -n "${p:-}" ]] && kill -0 "$p" 2>/dev/null; then
      if tr '\0' ' ' <"/proc/$p/cmdline" 2>/dev/null | grep -q 'cloudflared'; then
        echo "$p"
        return 0
      fi
    fi
  fi
  # Adopt any named-tunnel cloudflared on this box
  pgrep -f 'cloudflared tunnel .* run --token' 2>/dev/null | head -1 || true
}

find_next_pid() {
  if [[ -f "$NEXT_PID_FILE" ]]; then
    local p
    p="$(cat "$NEXT_PID_FILE" 2>/dev/null || true)"
    if [[ -n "${p:-}" ]] && kill -0 "$p" 2>/dev/null; then
      echo "$p"
      return 0
    fi
  fi
  # Prefer next-server listening on our port
  if command -v ss >/dev/null 2>&1; then
    local p
    p="$(ss -tlnp "sport = :$NEXT_PORT" 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1)"
    if [[ -n "${p:-}" ]]; then
      echo "$p"
      return 0
    fi
  fi
  pgrep -f "next dev -H 0.0.0.0 -p ${NEXT_PORT}" 2>/dev/null | head -1 || \
    pgrep -f "next start -H 0.0.0.0 -p ${NEXT_PORT}" 2>/dev/null | head -1 || true
}

start_tunnel() {
  ensure_cloudflared
  if [[ ! -f "$TOKEN_FILE" ]]; then
    log "ERROR: missing tunnel token file $TOKEN_FILE"
    return 1
  fi
  local existing
  existing="$(find_tunnel_pid)"
  if [[ -n "${existing:-}" ]]; then
    echo "$existing" >"$TUNNEL_PID_FILE"
    log "adopting existing cloudflared pid=$existing"
    return 0
  fi
  log "starting named cloudflared tunnel"
  # shellcheck disable=SC2094
  (
    exec 9>&-
    export TUNNEL_TOKEN
    TUNNEL_TOKEN="$(cat "$TOKEN_FILE")"
    exec "$CF_BIN" tunnel --no-autoupdate run --token "$TUNNEL_TOKEN"
  ) >>"$TUNNEL_LOG" 2>&1 &
  local pid=$!
  echo "$pid" >"$TUNNEL_PID_FILE"
  # also mirror log
  ln -sfn "$TUNNEL_LOG" "$TMP_MIRROR/tunnel.log" 2>/dev/null || true
  sleep 1
  if kill -0 "$pid" 2>/dev/null; then
    log "cloudflared started pid=$pid"
    return 0
  fi
  log "ERROR: cloudflared failed to stay up (see $TUNNEL_LOG)"
  return 1
}

start_next() {
  if port_listening "$NEXT_PORT"; then
    local existing
    existing="$(find_next_pid)"
    if [[ -n "${existing:-}" ]]; then
      echo "$existing" >"$NEXT_PID_FILE"
    fi
    log "adopting existing Next on :$NEXT_PORT pid=${existing:-unknown}"
    return 0
  fi
  log "starting local Next upstream on :$NEXT_PORT"
  (
    cd "$ROOT"
    exec 9>&- # children must not inherit the supervisor flock (else a restarted supervisor cannot start)
    export DISABLE_BOT_UPSTREAM=1
    export BOT_ROLE=upstream
    # Preserve Telegram token if already in environment for alert scripts / routes
    if [[ "${UPSTREAM_NEXT_MODE:-dev}" == "start" ]]; then
      exec npm run start
    else
      exec npm run dev
    fi
  ) >>"$NEXT_LOG" 2>&1 &
  local pid=$!
  echo "$pid" >"$NEXT_PID_FILE"
  ln -sfn "$NEXT_LOG" "$TMP_MIRROR/next.log" 2>/dev/null || true
  # Wait for listen
  local i
  for i in $(seq 1 45); do
    if port_listening "$NEXT_PORT"; then
      log "Next is listening on :$NEXT_PORT (pid=$pid, waited ${i}s)"
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      log "ERROR: Next process exited early (see $NEXT_LOG)"
      return 1
    fi
    sleep 1
  done
  log "ERROR: Next did not open :$NEXT_PORT within 45s"
  return 1
}

restart_tunnel() {
  local p
  p="$(find_tunnel_pid)"
  if [[ -n "${p:-}" ]]; then
    log "stopping cloudflared pid=$p"
    kill "$p" 2>/dev/null || true
    sleep 1
    kill -9 "$p" 2>/dev/null || true
  fi
  rm -f "$TUNNEL_PID_FILE"
  sleep "$RESTART_BACKOFF_SEC"
  start_tunnel || true
}

restart_next() {
  log "restarting Next upstream"
  # Kill tree listening on port + recorded pid
  local p
  p="$(find_next_pid)"
  if [[ -n "${p:-}" ]]; then
    kill "$p" 2>/dev/null || true
  fi
  # Also stop npm/next wrappers bound to this project
  pkill -f "$ROOT/node_modules/.bin/next" 2>/dev/null || true
  pkill -f "next dev -H 0.0.0.0 -p ${NEXT_PORT}" 2>/dev/null || true
  pkill -f "next start -H 0.0.0.0 -p ${NEXT_PORT}" 2>/dev/null || true
  sleep 1
  # Force free port if needed
  if port_listening "$NEXT_PORT"; then
    local lp
    lp="$(ss -tlnp "sport = :$NEXT_PORT" 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1)"
    if [[ -n "${lp:-}" ]]; then
      kill -9 "$lp" 2>/dev/null || true
    fi
  fi
  rm -f "$NEXT_PID_FILE"
  sleep "$RESTART_BACKOFF_SEC"
  NEXT_FAILS=0
  start_next || true
}

ensure_children() {
  local tpid npid
  tpid="$(find_tunnel_pid)"
  if [[ -z "${tpid:-}" ]]; then
    log "tunnel not running — starting"
    start_tunnel || true
  else
    echo "$tpid" >"$TUNNEL_PID_FILE"
  fi

  if ! port_listening "$NEXT_PORT"; then
    log "Next not listening on :$NEXT_PORT — starting"
    start_next || true
  else
    npid="$(find_next_pid)"
    if [[ -n "${npid:-}" ]]; then
      echo "$npid" >"$NEXT_PID_FILE"
    fi
  fi
}

health_tick() {
  local code tunnel_ok next_ok note
  code="$(http_code "$HEALTH_URL")"
  if [[ -n "$(find_tunnel_pid)" ]]; then tunnel_ok=true; else tunnel_ok=false; fi
  if port_listening "$NEXT_PORT"; then next_ok=true; else next_ok=false; fi

  if [[ "$code" == "200" ]]; then
    NEXT_FAILS=0
    note="ok"
  else
    NEXT_FAILS=$((NEXT_FAILS + 1))
    note="screen_http=$code fails=$NEXT_FAILS"
    log "health warn: $note"
    if [[ "$NEXT_FAILS" -ge "$NEXT_FAIL_THRESHOLD" ]]; then
      log "Next health failed ${NEXT_FAILS}x — auto-restart"
      restart_next
      code="$(http_code "$HEALTH_URL")"
      if port_listening "$NEXT_PORT"; then next_ok=true; else next_ok=false; fi
      note="restarted_next screen_http=$code"
    elif [[ "$next_ok" == "false" ]]; then
      start_next || true
    fi
  fi

  if [[ "$tunnel_ok" == "false" ]]; then
    log "tunnel missing — auto-restart"
    restart_tunnel
    if [[ -n "$(find_tunnel_pid)" ]]; then tunnel_ok=true; else tunnel_ok=false; fi
    note="${note}; tunnel_restarted"
  fi

  write_status "$next_ok" "$tunnel_ok" "$code" "$note"
}

find_early_pid() {
  if [[ -f "$EARLY_PID_FILE" ]]; then
    local p
    p="$(cat "$EARLY_PID_FILE" 2>/dev/null || true)"
    if [[ -n "${p:-}" ]] && kill -0 "$p" 2>/dev/null; then
      if tr '\0' ' ' <"/proc/$p/cmdline" 2>/dev/null | grep -q 'early-ignition-daemon'; then
        if ! tr '\0' ' ' <"/proc/$p/cmdline" 2>/dev/null | grep -q -- '--dry-run'; then
          echo "$p"
          return 0
        fi
      fi
    fi
  fi
  pgrep -af "node .*scripts/early-ignition-daemon.mjs" 2>/dev/null | grep -v -- '--dry-run' | awk '{print $1}' | head -1 || true
}

# Heartbeat age in seconds from status.json "at" (preferred) or mtime.
early_heartbeat_age() {
  local status_file="$EARLY_LOG_DIR/status.json"
  local age=99999 best=0 at_epoch=0 mtime_epoch=0
  if [[ -f "$status_file" ]]; then
    mtime_epoch="$(stat -c %Y "$status_file" 2>/dev/null || echo 0)"
    local at
    at="$(jq -r '.at // empty' "$status_file" 2>/dev/null || true)"
    if [[ -n "$at" ]]; then
      at_epoch="$(date -d "$at" +%s 2>/dev/null || echo 0)"
    fi
    best=$mtime_epoch
    if [[ "$at_epoch" =~ ^[0-9]+$ ]] && (( at_epoch > best )); then best=$at_epoch; fi
    if (( best > 0 )); then
      age=$(( $(date +%s) - best ))
      (( age < 0 )) && age=0
    fi
  fi
  echo "$age"
}

# Stale after 8 min (cycle ~60s; watch can take ~30s). Override with EARLY_STALE_SEC.
EARLY_STALE_SEC="${EARLY_STALE_SEC:-480}"

ensure_early() {
  [[ "$EARLY_ENABLED" == "1" ]] || return 0
  [[ -f "$EARLY_SCRIPT" ]] || return 0
  mkdir -p "$EARLY_LOG_DIR"
  # keep the daemon log bounded (child appends with O_APPEND, truncation is safe)
  if [[ -f "$EARLY_LOG" ]] && [[ "$(stat -c %s "$EARLY_LOG" 2>/dev/null || echo 0)" -gt "$EARLY_LOG_MAX_BYTES" ]]; then
    tail -n 3000 "$EARLY_LOG" >"$EARLY_LOG.tmp" 2>/dev/null && cat "$EARLY_LOG.tmp" >"$EARLY_LOG" && rm -f "$EARLY_LOG.tmp"
  fi
  local p age wake=0
  p="$(find_early_pid)"
  age="$(early_heartbeat_age)"
  if [[ -f "$WAKE_FLAG" ]]; then
    wake=1
    log "early-ignition wake flag present — forcing restart"
    rm -f "$WAKE_FLAG"
  fi
  # Healthy: live PID + fresh heartbeat + no wake
  if (( wake == 0 )) && [[ -n "${p:-}" ]] && (( age <= EARLY_STALE_SEC )); then
    echo "$p" >"$EARLY_PID_FILE"
    return 0
  fi
  # No PID: start within EARLY_DEAD_SEC (do not wait full STALE_SEC)
  if (( wake == 0 )) && [[ -z "${p:-}" ]] && (( age <= EARLY_DEAD_SEC )); then
    # brief grace for a just-spawned process before status appears
    :
  fi
  if [[ -n "${p:-}" ]] && { (( age > EARLY_STALE_SEC )) || (( wake == 1 )); }; then
    log "early-ignition daemon STALE/wake heartbeat age=${age}s (limit ${EARLY_STALE_SEC}s) pid=$p wake=$wake — killing for restart"
    kill "$p" 2>/dev/null || true
    sleep 2
    if kill -0 "$p" 2>/dev/null; then
      log "early-ignition daemon pid=$p still alive after SIGTERM — SIGKILL"
      kill -9 "$p" 2>/dev/null || true
      sleep 1
    fi
    rm -f "$EARLY_PID_FILE"
    p=""
  fi
  # Empty PID past dead grace, or after kill, or wake with no pid
  if [[ -z "${p:-}" ]]; then
    if (( wake == 0 )) && (( age <= EARLY_DEAD_SEC )); then
      # still in grace — but if age is huge (99999 missing file) start now
      if (( age < 90000 )); then
        return 0
      fi
    fi
    # Re-check in case another healer (watchdog) already started it
    p="$(find_early_pid)"
    if [[ -n "${p:-}" ]]; then
      echo "$p" >"$EARLY_PID_FILE"
      log "early-ignition daemon adopted pid=$p after stale/dead check"
      return 0
    fi
    log "early-ignition daemon not running (age=${age}s wake=$wake) — starting"
    (
      cd "$ROOT"
      exec 9>&- # do not let the daemon inherit the supervisor flock
      exec node "$EARLY_SCRIPT"
    ) >>"$EARLY_LOG" 2>&1 &
    echo "$!" >"$EARLY_PID_FILE"
    sleep "$RESTART_BACKOFF_SEC"
  fi
}

main_loop() {
  log "bot-upstream supervisor start root=$ROOT logDir=$LOG_DIR"
  ensure_cloudflared
  ensure_children
  ensure_early
  # Initial status
  health_tick
  while true; do
    sleep "$POLL_SEC"
    # Detect dead tunnel process even if we thought it was up
    if [[ -z "$(find_tunnel_pid)" ]]; then
      log "detected dead tunnel"
      restart_tunnel
    fi
    if ! port_listening "$NEXT_PORT"; then
      log "detected Next port down"
      restart_next
    fi
    health_tick
    ensure_early
  done
}

# Single instance
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another bot-upstream supervisor holds $LOCK_FILE — exiting" >&2
  exit 0
fi

main_loop
