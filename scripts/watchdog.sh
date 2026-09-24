#!/usr/bin/env bash
# Single watchdog for everything that must never stay down ("ห้ามล่ม").
#   - supervise-bot-upstream.sh (it restarts Next :3000, cloudflared tunnel, early-ignition daemon)
#   - supervise-local-scheduler.sh (check-now-alerts + evaluate-alert-outcomes every 5 min)
#   - early daemon liveness (status.json heartbeat; a hung daemon is killed so the supervisor restarts it)
#   - local Next /api/screen + /api/early-tiers, public Workers /api/early-tiers
# Restarts use exponential backoff (60s → 10 min). Telegram warning only after sustained real failure
# (not flapping), at most once per 2h per problem, plus one "recovered" message.
# Single instance via flock. Started by scripts/start-all.sh (which local-scheduler re-runs every 5 min).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
mkdir -p logs
LOG="$ROOT/logs/watchdog.log"
STATUS="$ROOT/logs/watchdog-status.json"
LOCK="${WATCHDOG_LOCK:-/tmp/crypto-pump-watchdog.lock}"
exec 8>"$LOCK"
flock -n 8 || exit 0

PORT="${UPSTREAM_NEXT_PORT:-3000}"
PUBLIC_URL="${WATCHDOG_PUBLIC_URL:-https://crypto-pump-screener.jakahome2.workers.dev/api/early-tiers}"
POLL=30
DAEMON_STATUS="$ROOT/logs/early-ignition/status.json"
DAEMON_PID_FILE="$ROOT/logs/early-ignition/daemon.pid"

declare -A FAILS LAST_ALERT ALERTED NEXT_RESTART BACKOFF
log() { echo "[$(date -Iseconds)] $*" >>"$LOG"; }
now() { date +%s; }
tg() { timeout 30 node scripts/send-telegram.mjs "$1" >>"$LOG" 2>&1 || log "telegram send failed"; }

# problem KEY is failing; alert once FAILS >= threshold, re-alert at most every 2h
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
# restart gate with exponential backoff per key
may_restart() {
  local key="$1" t; t=$(now)
  if (( t < ${NEXT_RESTART[$key]:-0} )); then return 1; fi
  local b=${BACKOFF[$key]:-60}
  NEXT_RESTART[$key]=$(( t + b ))
  BACKOFF[$key]=$(( b * 2 > 600 ? 600 : b * 2 ))
  return 0
}
reset_backoff() { BACKOFF[$1]=60; }
running() { pgrep -f "$1" >/dev/null 2>&1; }
start_detached() { # $1 script, $2 logfile
  setsid nohup bash "$1" >>"$2" 2>&1 </dev/null 8>&- &
}
http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time "${2:-15}" "$1" 2>/dev/null || echo 000; }

log "watchdog start pid=$$"
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
  # 2) early daemon heartbeat (cycle every ~60s; watch cycle can take ~30s)
  age=9999
  [[ -f "$DAEMON_STATUS" ]] && age=$(( $(now) - $(stat -c %Y "$DAEMON_STATUS") ))
  if (( age <= 300 )); then
    errs=$(jq -r '.consecutiveErrors // 0' "$DAEMON_STATUS" 2>/dev/null || echo 0)
    if (( errs >= 15 )); then fail daemon_err 1 "early daemon เรียก Binance ไม่สำเร็จ ${errs} รอบติด"; else ok daemon_err "early daemon (Binance API)"; fi
    ok daemon "early daemon"; reset_backoff daemon
  else
    fail daemon 4 "early daemon ไม่มี heartbeat ${age}s"
    if may_restart daemon; then
      p=$(cat "$DAEMON_PID_FILE" 2>/dev/null)
      if [[ -n "$p" ]] && kill -0 "$p" 2>/dev/null; then log "daemon heartbeat stale (${age}s) — killing pid=$p for supervisor restart"; kill "$p" 2>/dev/null; fi
    fi
  fi
  # 3) local Next (supervisor restarts it after 3 failed polls; we only escalate if it stays down ~5 min)
  c1=$(http_code "http://127.0.0.1:${PORT}/api/early-tiers" 15)
  if [[ "$c1" == 200 ]]; then ok next "เว็บหลัก (Next :${PORT})"; else fail next 10 "เว็บหลัก Next :${PORT} ตอบ ${c1}"; fi
  # 4) public Workers path every 5 min (tunnel + VPC); 3 fails in a row = 15 min
  if (( tick % 10 == 1 )); then
    c2=$(http_code "$PUBLIC_URL" 25)
    if [[ "$c2" == 200 ]]; then ok public "เว็บสาธารณะ (Workers)"; else log "public $PUBLIC_URL -> $c2"; fail public 3 "เว็บสาธารณะ Workers /api/early-tiers ตอบ ${c2}"; fi
  fi
  # status + log rotation
  printf '{"at":"%s","pid":%s,"daemonHeartbeatAgeSec":%s,"nextHttp":"%s","publicHttp":"%s","fails":{"sup_up":%s,"sup_sched":%s,"daemon":%s,"next":%s,"public":%s}}\n' \
    "$(date -Iseconds)" "$$" "$age" "$c1" "${c2:-}" "${FAILS[sup_up]:-0}" "${FAILS[sup_sched]:-0}" "${FAILS[daemon]:-0}" "${FAILS[next]:-0}" "${FAILS[public]:-0}" >"$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"
  if [[ $(stat -c %s "$LOG" 2>/dev/null || echo 0) -gt 2000000 ]]; then tail -c 500000 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"; fi
  sleep "$POLL"
done
