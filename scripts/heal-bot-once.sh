#!/usr/bin/env bash
# One-shot independent healer (NOT a long-running loop).
# Invoked by local-scheduler every ~2 minutes so a frozen watchdog/supervisor
# cannot leave Next/tunnel/early-daemon dead for hours.
# Safe to run concurrently (flock); exits quickly; never inherits other locks.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

if [[ -f "$ROOT/.env.secrets" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env.secrets"
  set +a
fi

LOG_DIR="$ROOT/logs/heal-once"
mkdir -p "$LOG_DIR" logs/early-ignition logs/bot-upstream
LOG="$LOG_DIR/heal.log"
LOCK="${HEAL_ONCE_LOCK:-/tmp/crypto-pump-heal-once.lock}"
STATUS="$LOG_DIR/status.json"

exec 7>"$LOCK"
if ! flock -n 7; then
  echo "[$(date -Iseconds)] heal-once skipped (lock held)" >>"$LOG"
  exit 0
fi

PORT="${UPSTREAM_NEXT_PORT:-3000}"
DAEMON_STALE_SEC="${HEAL_DAEMON_STALE_SEC:-480}"
DAEMON_STATUS="$ROOT/logs/early-ignition/status.json"
DAEMON_PID_FILE="$ROOT/logs/early-ignition/daemon.pid"
DAEMON_LOG="$ROOT/logs/early-ignition/daemon.log"
DAEMON_SCRIPT="$ROOT/scripts/early-ignition-daemon.mjs"
WAKE_FLAG="$ROOT/logs/early-ignition/wake.flag"
WATCHDOG_STATUS="$ROOT/logs/watchdog-status.json"
SUPER_STATUS="$ROOT/logs/bot-upstream/status.json"
TOKEN_FILE="${TUNNEL_TOKEN_FILE:-$ROOT/.tunnel-token}"
CF_BIN="${CLOUDFLARED_BIN:-/tmp/cloudflared}"

log() { echo "[$(date -Iseconds)] $*" | tee -a "$LOG" >/dev/null; }
now() { date +%s; }

# Hard-timeout curl so this script itself cannot hang the scheduler.
http_code() {
  local url="$1" t="${2:-8}"
  timeout $((t + 2)) curl -sS -o /dev/null -w '%{http_code}' --max-time "$t" --connect-timeout 3 "$url" 2>/dev/null || echo 000
}

file_age() {
  local f="$1"
  if [[ -f "$f" ]]; then
    echo $(( $(now) - $(stat -c %Y "$f") ))
  else
    echo 99999
  fi
}

daemon_heartbeat_age() {
  # Prefer JSON "at" (daemon's own heartbeat). mtime alone is misleading when
  # another process rewrites the file with a stale "at".
  local age=99999 at_epoch=0 mtime_epoch=0
  if [[ -f "$DAEMON_STATUS" ]]; then
    mtime_epoch=$(stat -c %Y "$DAEMON_STATUS" 2>/dev/null || echo 0)
    local at
    at=$(jq -r '.at // empty' "$DAEMON_STATUS" 2>/dev/null || true)
    if [[ -n "$at" ]]; then
      at_epoch=$(date -d "$at" +%s 2>/dev/null || echo 0)
    fi
    local best=0
    if [[ "$at_epoch" =~ ^[0-9]+$ ]] && (( at_epoch > 0 )); then
      best=$at_epoch
    elif (( mtime_epoch > 0 )); then
      best=$mtime_epoch
    fi
    if (( best > 0 )); then
      age=$(( $(now) - best ))
      (( age < 0 )) && age=0
    fi
  fi
  echo "$age"
}

find_daemon_pids() {
  local -a out=()
  local p
  if [[ -f "$DAEMON_PID_FILE" ]]; then
    p=$(cat "$DAEMON_PID_FILE" 2>/dev/null || true)
    if [[ -n "${p:-}" ]] && kill -0 "$p" 2>/dev/null; then
      if tr '\0' ' ' <"/proc/$p/cmdline" 2>/dev/null | grep -q 'early-ignition-daemon'; then
        if ! tr '\0' ' ' <"/proc/$p/cmdline" 2>/dev/null | grep -q -- '--dry-run'; then
          out+=("$p")
        fi
      fi
    fi
  fi
  while read -r p; do
    [[ -z "$p" ]] && continue
    local seen=0 cmd
    for x in "${out[@]:-}"; do [[ "$x" == "$p" ]] && seen=1 && break; done
    (( seen )) && continue
    cmd="$(tr '\0' ' ' <"/proc/$p/cmdline" 2>/dev/null || true)"
    case "$cmd" in
      *early-ignition-daemon.mjs*) ;;
      *) continue ;;
    esac
    case "$cmd" in *--dry-run*) continue ;; esac
    case "$cmd" in *node*|*/node*) ;; *) continue ;; esac
    out+=("$p")
  done < <(pgrep -f "early-ignition-daemon\.mjs" 2>/dev/null | head -8 || true)
  echo "${out[*]:-}"
}

port_listening() {
  if command -v ss >/dev/null 2>&1; then
    ss -tlnH "sport = :$PORT" 2>/dev/null | grep -q LISTEN
  else
    http_code "http://127.0.0.1:${PORT}/api/health" 2 | grep -q 200
  fi
}

tunnel_pid() {
  # Require real cloudflared binary via /proc/pid/exe — never match a shell whose
  # argv merely contains the words "cloudflared tunnel run --token".
  local p exe cmd
  for p in $(ls -d /proc/[0-9]* 2>/dev/null); do
    exe="$(readlink -f "$p/exe" 2>/dev/null || true)"
    case "$exe" in
      */cloudflared) ;;
      *) continue ;;
    esac
    cmd="$(tr '\0' ' ' <"$p/cmdline" 2>/dev/null || true)"
    case "$cmd" in
      *tunnel*run*--token*|*tunnel*--no-autoupdate*run*)
        echo "${p#/proc/}"
        return 0
        ;;
    esac
  done
  return 0
}

script_running() {
  local want="$1" base pid a0 a1
  base=$(basename "$want")
  for pid in $(pgrep -f "$base" 2>/dev/null); do
    a0=$(tr '\0' '\n' <"/proc/$pid/cmdline" 2>/dev/null | sed -n '1p')
    a1=$(tr '\0' '\n' <"/proc/$pid/cmdline" 2>/dev/null | sed -n '2p')
    case "$a0" in *bash*) ;; *) continue ;; esac
    if [[ "$a1" == "$want" || "$a1" == "$ROOT/$want" || "$a1" == */"$want" || "$a1" == */scripts/"$base" ]]; then
      echo "$pid"
      return 0
    fi
  done
  return 1
}

start_detached() {
  setsid nohup bash "$1" >>"$2" 2>&1 </dev/null 7>&- 8>&- 9>&- &
}

actions=()

# --- 1) Next :3000 ---
if ! port_listening; then
  log "Next :$PORT down — starting via supervise-bot-upstream"
  actions+=("start_next")
  if ! script_running "scripts/supervise-bot-upstream.sh" >/dev/null; then
    start_detached scripts/supervise-bot-upstream.sh logs/bot-upstream/nohup.out
  fi
  # Also try direct start if port still down after brief wait
  sleep 2
  if ! port_listening; then
    (
      cd "$ROOT"
      exec 7>&- 8>&- 9>&-
      export DISABLE_BOT_UPSTREAM=1 BOT_ROLE=upstream
      exec npm run dev
    ) >>logs/bot-upstream/next.log 2>&1 &
    log "Next direct start pid=$!"
  fi
fi

# --- 2) cloudflared tunnel ---
tp=$(tunnel_pid)
if [[ -z "${tp:-}" ]]; then
  log "tunnel missing — starting"
  actions+=("start_tunnel")
  if [[ -x "$CF_BIN" && -f "$TOKEN_FILE" ]]; then
    (
      exec 7>&- 8>&- 9>&-
      TUNNEL_TOKEN="$(cat "$TOKEN_FILE")"
      exec "$CF_BIN" tunnel --no-autoupdate run --token "$TUNNEL_TOKEN"
    ) >>logs/bot-upstream/tunnel.log 2>&1 &
    echo $! >logs/bot-upstream/tunnel.pid
    log "tunnel started pid=$!"
  else
    log "ERROR: cannot start tunnel (bin or token missing)"
  fi
fi

# --- 3) early daemon (stale / dead / wake) ---
age=$(daemon_heartbeat_age)
pids=$(find_daemon_pids)
wake=0
[[ -f "$WAKE_FLAG" ]] && wake=1 && rm -f "$WAKE_FLAG" && log "consumed wake.flag"

need_daemon=0
reason=""
if (( wake == 1 )); then need_daemon=1; reason="wake"; fi
if [[ -z "${pids// /}" ]]; then need_daemon=1; reason="${reason:+$reason+}dead"; fi
if (( age > DAEMON_STALE_SEC )); then need_daemon=1; reason="${reason:+$reason+}stale:${age}s"; fi

if (( need_daemon == 1 )); then
  log "healing daemon reason=${reason:-unknown} age=${age}s pids=[${pids}]"
  actions+=("heal_daemon:$reason")
  for p in $pids; do
    kill "$p" 2>/dev/null || true
  done
  sleep 1
  for p in $pids; do
    kill -9 "$p" 2>/dev/null || true
  done
  rm -f "$DAEMON_PID_FILE"
  sleep 1
  left=$(find_daemon_pids)
  if [[ -z "${left// /}" ]]; then
    (
      cd "$ROOT"
      exec 7>&- 8>&- 9>&-
      exec node "$DAEMON_SCRIPT"
    ) >>"$DAEMON_LOG" 2>&1 &
    echo $! >"$DAEMON_PID_FILE"
    log "daemon started pid=$!"
  else
    echo "$left" | awk '{print $1}' >"$DAEMON_PID_FILE"
    log "daemon already alive after kill attempt pids=$left"
  fi
fi

# --- 4) Restart frozen long-running loops (heartbeat stale > 3 min) ---
wd_age=$(file_age "$WATCHDOG_STATUS")
sup_age=$(file_age "$SUPER_STATUS")
# Watchdog should write status every ≤30s when healthy; 180s = frozen
if (( wd_age > 180 )); then
  log "watchdog status age=${wd_age}s — restarting frozen watchdog"
  actions+=("restart_watchdog")
  wd_pid=$(script_running "scripts/watchdog.sh" || true)
  if [[ -n "${wd_pid:-}" ]]; then
    kill "$wd_pid" 2>/dev/null || true
    sleep 1
    kill -9 "$wd_pid" 2>/dev/null || true
  fi
  # Drop stale lock so new instance can start
  rm -f /tmp/crypto-pump-watchdog.lock
  start_detached scripts/watchdog.sh logs/watchdog.nohup.out
fi

if (( sup_age > 180 )); then
  log "supervisor status age=${sup_age}s — restarting frozen supervisor"
  actions+=("restart_supervisor")
  sp=$(script_running "scripts/supervise-bot-upstream.sh" || true)
  if [[ -n "${sp:-}" ]]; then
    kill "$sp" 2>/dev/null || true
    sleep 1
    kill -9 "$sp" 2>/dev/null || true
  fi
  rm -f /tmp/crypto-pump-bot-upstream.lock
  start_detached scripts/supervise-bot-upstream.sh logs/bot-upstream/nohup.out
fi

# Ensure supervisors exist even if status is fresh but process gone
if ! script_running "scripts/watchdog.sh" >/dev/null; then
  log "watchdog not running — starting"
  actions+=("start_watchdog")
  rm -f /tmp/crypto-pump-watchdog.lock
  start_detached scripts/watchdog.sh logs/watchdog.nohup.out
fi
if ! script_running "scripts/supervise-bot-upstream.sh" >/dev/null; then
  log "supervisor not running — starting"
  actions+=("start_supervisor")
  rm -f /tmp/crypto-pump-bot-upstream.lock
  start_detached scripts/supervise-bot-upstream.sh logs/bot-upstream/nohup.out
fi

# Trim heal log
if [[ $(stat -c %s "$LOG" 2>/dev/null || echo 0) -gt 1000000 ]]; then
  tail -c 300000 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

next_http=$(http_code "http://127.0.0.1:${PORT}/api/health" 5)
early_http=$(http_code "http://127.0.0.1:${PORT}/api/early-tiers" 8)
age2=$(daemon_heartbeat_age)
pids2=$(find_daemon_pids)
tp2=$(tunnel_pid)

jq -nc \
  --arg at "$(date -Iseconds)" \
  --arg nextHttp "$next_http" \
  --arg earlyHttp "$early_http" \
  --argjson daemonAge "$age2" \
  --arg daemonPids "${pids2}" \
  --arg tunnelPid "${tp2:-}" \
  --argjson actions "$(printf '%s\n' "${actions[@]:-}" | jq -R . | jq -s .)" \
  '{at:$at,nextHttp:$nextHttp,earlyHttp:$earlyHttp,daemonAgeSec:$daemonAge,daemonPids:$daemonPids,tunnelPid:$tunnelPid,actions:$actions}' \
  >"$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"

(( ${#actions[@]} > 0 )) && log "done actions=${actions[*]} next=$next_http early=$early_http daemonAge=$age2"
exit 0
