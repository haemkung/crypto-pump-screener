#!/usr/bin/env bash
# Single watchdog for everything that must never stay down ("ห้ามล่ม").
#   - supervise-bot-upstream.sh (Next :3000, cloudflared tunnel, early-ignition daemon)
#   - supervise-local-scheduler.sh (check-now-alerts + evaluate-alert-outcomes every 5 min)
#   - early daemon liveness: dead PID OR stale heartbeat (status.json age) → kill + start
#   - local Next /api/early-tiers, public Workers /api/early-tiers
# Restarts use exponential backoff (30s → 5 min). Telegram warning only after sustained real failure
# (not flapping), at most once per 2h per problem, plus one "recovered" message.
# Single instance via flock. Started by scripts/start-all.sh (which local-scheduler re-runs every 5 min).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
mkdir -p logs logs/early-ignition logs/bot-upstream
LOG="$ROOT/logs/watchdog.log"
STATUS="$ROOT/logs/watchdog-status.json"
LOCK="${WATCHDOG_LOCK:-/tmp/crypto-pump-watchdog.lock}"
exec 8>"$LOCK"
flock -n 8 || exit 0

PORT="${UPSTREAM_NEXT_PORT:-3000}"
PUBLIC_URL="${WATCHDOG_PUBLIC_URL:-https://crypto-pump-screener.jakahome2.workers.dev/api/early-tiers}"
POLL=30
# Daemon cycles ~60s; watch scan can take ~20–30s. Stale after 8 min → restart.
DAEMON_STALE_SEC="${WATCHDOG_DAEMON_STALE_SEC:-480}"
DAEMON_STATUS="$ROOT/logs/early-ignition/status.json"
DAEMON_PID_FILE="$ROOT/logs/early-ignition/daemon.pid"
DAEMON_LOG="$ROOT/logs/early-ignition/daemon.log"
DAEMON_SCRIPT="$ROOT/scripts/early-ignition-daemon.mjs"
WAKE_FLAG="$ROOT/logs/early-ignition/wake.flag"
# No live PID → heal within ~90s even if status.json looks recent.
DAEMON_DEAD_SEC="${WATCHDOG_DAEMON_DEAD_SEC:-90}"

declare -A FAILS LAST_ALERT ALERTED NEXT_RESTART BACKOFF
log() { echo "[$(date -Iseconds)] $*" >>"$LOG"; }
now() { date +%s; }
tg() { timeout 30 node scripts/send-telegram.mjs "$1" >>"$LOG" 2>&1 || log "telegram send failed"; }

fail() {
  local key="$1" thr="$2" msg="$3"
  FAILS[$key]=$(( ${FAILS[$key]:-0} + 1 ))
  if (( FAILS[$key] >= thr )); then
    local t; t=$(now)
    if (( t - ${LAST_ALERT[$key]:-0} >= 7200 )); then
      tg "⚠️ crypto-pump-screener: ${msg} (ล้มเหลวต่อเนื่อง ${FAILS[$key]} ครั้ง) — ระบบกำลังรีสตาร์ทอัตโนมัติ"
      LAST_ALERT[$key]=$t; ALERTED[$key]=1
    fi
  fi
}
ok() {
  local key="$1" name="$2"
  if [[ "${ALERTED[$key]:-0}" == 1 ]]; then tg "✅ crypto-pump-screener: ${name} กลับมาทำงานปกติแล้ว"; fi
  FAILS[$key]=0; ALERTED[$key]=0
}
may_restart() {
  local key="$1" t; t=$(now)
  if (( t < ${NEXT_RESTART[$key]:-0} )); then return 1; fi
  local b=${BACKOFF[$key]:-30}
  NEXT_RESTART[$key]=$(( t + b ))
  BACKOFF[$key]=$(( b * 2 > 300 ? 300 : b * 2 ))
  return 0
}
reset_backoff() { BACKOFF[$1]=30; NEXT_RESTART[$1]=0; }
# True only when argv[1] is the script (avoids false hits from shells that merely mention the path).
running() {
  local want="$1" base pid a0 a1
  base=$(basename "$want")
  for pid in $(pgrep -f "$base" 2>/dev/null); do
    a0=$(tr '\0' '\n' <"/proc/$pid/cmdline" 2>/dev/null | sed -n '1p')
    a1=$(tr '\0' '\n' <"/proc/$pid/cmdline" 2>/dev/null | sed -n '2p')
    case "$a0" in *bash*) ;; *) continue ;; esac
    if [[ "$a1" == "$want" || "$a1" == "$ROOT/$want" || "$a1" == */"$want" || "$a1" == */scripts/"$base" ]]; then
      return 0
    fi
  done
  return 1
}
start_detached() { # $1 script, $2 logfile
  setsid nohup bash "$1" >>"$2" 2>&1 </dev/null 8>&- &
}
http_code() { local t="${2:-12}"; timeout $((t + 3)) curl -s -o /dev/null -w '%{http_code}' --max-time "$t" --connect-timeout 3 "$1" 2>/dev/null || echo 000; }

# Heartbeat age: prefer JSON "at" (ISO), fall back to mtime. Returns seconds or 99999 if missing.
daemon_heartbeat_age() {
  local age=99999 at_epoch=0 mtime_epoch=0
  if [[ -f "$DAEMON_STATUS" ]]; then
    mtime_epoch=$(stat -c %Y "$DAEMON_STATUS" 2>/dev/null || echo 0)
    local at
    at=$(jq -r '.at // empty' "$DAEMON_STATUS" 2>/dev/null || true)
    if [[ -n "$at" ]]; then
      at_epoch=$(date -d "$at" +%s 2>/dev/null || echo 0)
    fi
    local best=0
    if (( at_epoch > 0 )); then best=$at_epoch
    elif (( mtime_epoch > 0 )); then best=$mtime_epoch; fi
    if (( best > 0 )); then
      age=$(( $(now) - best ))
      (( age < 0 )) && age=0
    fi
  fi
  echo "$age"
}

# PIDs that look like the early-ignition daemon (pidfile + pgrep).
find_daemon_pids() {
  local -a pids=()
  local p
  if [[ -f "$DAEMON_PID_FILE" ]]; then
    p=$(cat "$DAEMON_PID_FILE" 2>/dev/null || true)
    if [[ -n "${p:-}" ]] && kill -0 "$p" 2>/dev/null; then
      if tr '\0' ' ' <"/proc/$p/cmdline" 2>/dev/null | grep -q 'early-ignition-daemon'; then
        pids+=("$p")
      fi
    fi
  fi
  while read -r p; do
    [[ -z "$p" ]] && continue
    local seen=0
    for x in "${pids[@]:-}"; do [[ "$x" == "$p" ]] && seen=1 && break; done
    (( seen )) || pids+=("$p")
  done < <(pgrep -f "node .*early-ignition-daemon\.mjs" 2>/dev/null | head -5 || true)
  # exclude dry-run
  local -a out=()
  for p in "${pids[@]:-}"; do
    if tr '\0' ' ' <"/proc/$p/cmdline" 2>/dev/null | grep -q -- '--dry-run'; then continue; fi
    out+=("$p")
  done
  echo "${out[*]:-}"
}

kill_daemon_pids() {
  local reason="$1"
  local pids
  pids=$(find_daemon_pids)
  if [[ -z "${pids// /}" ]]; then
    log "daemon restart ($reason): no live PID to kill"
    rm -f "$DAEMON_PID_FILE"
    return 0
  fi
  for p in $pids; do
    log "daemon restart ($reason): sending SIGTERM to pid=$p"
    kill "$p" 2>/dev/null || true
  done
  sleep 2
  for p in $pids; do
    if kill -0 "$p" 2>/dev/null; then
      log "daemon restart ($reason): SIGKILL pid=$p"
      kill -9 "$p" 2>/dev/null || true
    fi
  done
  rm -f "$DAEMON_PID_FILE"
}

start_daemon() {
  mkdir -p "$(dirname "$DAEMON_LOG")"
  if [[ ! -f "$DAEMON_SCRIPT" ]]; then
    log "ERROR: missing $DAEMON_SCRIPT"
    return 1
  fi
  # Load secrets so AI review keys are available (same as supervisor)
  if [[ -f "$ROOT/.env.secrets" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$ROOT/.env.secrets"
    set +a
  fi
  (
    cd "$ROOT"
    exec 8>&- 9>&-
    exec node "$DAEMON_SCRIPT"
  ) >>"$DAEMON_LOG" 2>&1 &
  local pid=$!
  echo "$pid" >"$DAEMON_PID_FILE"
  log "daemon started pid=$pid (watchdog direct start)"
  sleep 2
  if kill -0 "$pid" 2>/dev/null; then return 0; fi
  log "ERROR: daemon pid=$pid exited immediately"
  return 1
}


# UI / API wake request: flag file written by POST /api/early-daemon/wake
consume_wake_flag() {
  if [[ -f "$WAKE_FLAG" ]]; then
    log "wake flag present — forcing daemon heal"
    rm -f "$WAKE_FLAG"
    return 0
  fi
  return 1
}

# Full heal: kill stale/dead, start if still absent.
heal_daemon() {
  local reason="$1" age="$2"
  kill_daemon_pids "$reason age=${age}s"
  sleep 1
  local left
  left=$(find_daemon_pids)
  if [[ -n "${left// /}" ]]; then
    log "daemon heal: still alive after kill ($left) — trying SIGKILL"
    for p in $left; do kill -9 "$p" 2>/dev/null || true; done
    sleep 1
  fi
  left=$(find_daemon_pids)
  if [[ -z "${left// /}" ]]; then
    start_daemon || true
  else
    log "daemon heal: process still present ($left); writing pidfile and relying on next tick"
    echo "$left" | awk '{print $1}' >"$DAEMON_PID_FILE"
  fi
}

log "watchdog start pid=$$ staleSec=$DAEMON_STALE_SEC"
tick=0
while true; do
  tick=$((tick + 1))
  # 1) supervisors
  if running "scripts/supervise-bot-upstream.sh"; then ok sup_up "supervisor (Next/tunnel/daemon)"; reset_backoff sup_up
  else
    fail sup_up 3 "ตัวคุม Next/tunnel/daemon หยุด"
    if may_restart sup_up; then log "starting supervise-bot-upstream.sh"; mkdir -p logs/bot-upstream; start_detached scripts/supervise-bot-upstream.sh logs/bot-upstream/nohup.out; fi
  fi
  if running "scripts/supervise-local-scheduler.sh"; then ok sup_sched "ตัวตั้งเวลาแจ้งเตือน"; reset_backoff sup_sched
  else
    fail sup_sched 3 "ตัวตั้งเวลาแจ้งเตือน (เข้าตอนนี้/รอแท่งกลับ) หยุด"
    if may_restart sup_sched; then log "starting supervise-local-scheduler.sh"; start_detached scripts/supervise-local-scheduler.sh logs/local-scheduler.nohup.out; fi
  fi

  # 2) early daemon: wake flag OR dead PID OR stale heartbeat → kill + start
  age=$(daemon_heartbeat_age)
  live_pids=$(find_daemon_pids)
  wake=0
  if consume_wake_flag; then wake=1; fi

  # Healthy only when live PID AND fresh heartbeat AND no wake request
  if (( wake == 0 )) && (( age <= DAEMON_STALE_SEC )) && [[ -n "${live_pids// /}" ]]; then
    errs=$(jq -r '.consecutiveErrors // 0' "$DAEMON_STATUS" 2>/dev/null || echo 0)
    if [[ "$errs" =~ ^[0-9]+$ ]] && (( errs >= 15 )); then
      fail daemon_err 1 "early daemon เรียก Binance ไม่สำเร็จ ${errs} รอบติด"
    else
      ok daemon_err "early daemon (Binance API)"
    fi
    ok daemon "early daemon"; reset_backoff daemon
  else
    local_reason="unknown"
    if (( wake == 1 )); then local_reason="wake_flag"
    elif [[ -z "${live_pids// /}" ]] && (( age > DAEMON_STALE_SEC )); then local_reason="dead+stale"
    elif [[ -z "${live_pids// /}" ]]; then local_reason="dead"
    else local_reason="stale_heartbeat"; fi
    # Dead (no PID): treat as unhealthy after DAEMON_DEAD_SEC even if status.json is newer
    if [[ "$local_reason" == "dead" ]] && (( age <= DAEMON_DEAD_SEC )) && (( wake == 0 )); then
      # Very recent status with no PID — give process a moment to spawn, but never more than DEAD_SEC
      if (( tick % 2 == 1 )); then
        log "daemon missing pid age=${age}s (deadSec=$DAEMON_DEAD_SEC) — waiting brief grace"
      fi
    else
      if (( tick % 2 == 1 )) || (( wake == 1 )); then
        log "daemon unhealthy reason=$local_reason age=${age}s pids=[${live_pids}] fails=${FAILS[daemon]:-0}"
      fi
      fail daemon 2 "early daemon ${local_reason} (heartbeat ${age}s)"
      # Dead / wake: bypass exponential backoff so multi-hour gaps cannot happen
      if [[ "$local_reason" == "dead" || "$local_reason" == "dead+stale" || "$local_reason" == "wake_flag" ]]; then
        reset_backoff daemon
        NEXT_RESTART[daemon]=0
      fi
      if may_restart daemon; then
        log "healing early daemon reason=$local_reason age=${age}s pids=[${live_pids}]"
        heal_daemon "$local_reason" "$age"
      fi
    fi
  fi

  # 3) local Next
  c1=$(http_code "http://127.0.0.1:${PORT}/api/early-tiers" 15)
  if [[ "$c1" == 200 ]]; then ok next "เว็บหลัก (Next :${PORT})"; else fail next 10 "เว็บหลัก Next :${PORT} ตอบ ${c1}"; fi
  # 4) public Workers every ~5 min
  if (( tick % 10 == 1 )); then
    c2=$(http_code "$PUBLIC_URL" 25)
    if [[ "$c2" == 200 ]]; then ok public "เว็บสาธารณะ (Workers)"; else log "public $PUBLIC_URL -> $c2"; fail public 3 "เว็บสาธารณะ Workers /api/early-tiers ตอบ ${c2}"; fi
  fi
    if (( tick % 10 == 1 )); then log "watchdog tick=$tick daemonAge=${age}s pids=[${live_pids}] next=$c1"; fi
  printf '{"at":"%s","pid":%s,"daemonHeartbeatAgeSec":%s,"daemonPids":"%s","nextHttp":"%s","publicHttp":"%s","fails":{"sup_up":%s,"sup_sched":%s,"daemon":%s,"next":%s,"public":%s}}\n' \
    "$(date -Iseconds)" "$$" "$age" "${live_pids}" "$c1" "${c2:-}" "${FAILS[sup_up]:-0}" "${FAILS[sup_sched]:-0}" "${FAILS[daemon]:-0}" "${FAILS[next]:-0}" "${FAILS[public]:-0}" >"$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"
  if [[ $(stat -c %s "$LOG" 2>/dev/null || echo 0) -gt 2000000 ]]; then tail -c 500000 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"; fi
  # Unhealthy / no PID → poll every 5s so empty-PID gaps heal within ~1–2 min max
  if [[ -z "${live_pids// /}" ]] || (( age > DAEMON_STALE_SEC )) || (( wake == 1 )); then
    sleep 5
  else
    sleep "$POLL"
  fi
done
