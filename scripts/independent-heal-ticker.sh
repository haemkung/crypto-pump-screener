#!/usr/bin/env bash
# Ultra-thin independent heal ticker. ONLY runs heal-bot-once every ~2 min.
# Survives local-scheduler freezes (evaluate/alerts can hang for minutes).
# Detects sandbox/host wall-clock jumps (box sleep) and re-heals immediately
# so a 12h freeze cannot leave the early daemon silent until humans notice.
#
# CRITICAL (2026-09-30): when node_modules/.bin/next is wiped, npm ci takes
# several minutes. The old 90s timeout around heal-bot-once killed npm ci mid-run
# forever → :3000 stayed dead for hours. Now we run ensure-next-deps FIRST with
# a long budget whenever the next binary is missing, then heal-bot-once.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
LOCK="${INDEPENDENT_HEAL_LOCK:-/tmp/crypto-pump-independent-heal.lock}"
LOG="$ROOT/logs/heal-once/independent-ticker.log"
HB="$ROOT/logs/heal-once/ticker-heartbeat.json"
NEXT_BIN="$ROOT/node_modules/.bin/next"
ENSURE_TIMEOUT_SEC="${ENSURE_NEXT_TIMEOUT_SEC:-700}"
HEAL_TIMEOUT_SEC="${HEAL_ONCE_TIMEOUT_SEC:-90}"
mkdir -p "$ROOT/logs/heal-once"
exec 8>"$LOCK"
if ! flock -n 8; then
  echo "[$(date -Iseconds)] independent-heal-ticker already running" >>"$LOG"
  exit 0
fi
echo "[$(date -Iseconds)] independent-heal-ticker start pid=$$" >>"$LOG"
write_hb() {
  local phase="$1" extra="${2:-}"
  printf '{"at":"%s","pid":%s,"phase":"%s"%s}\n' \
    "$(date -Iseconds)" "$$" "$phase" "${extra}" >"$HB" 2>/dev/null || true
}
write_hb "start"
# Stagger so we don't always collide with local-scheduler's :even minute bucket
sleep 7
while true; do
  t0=$(date +%s)
  write_hb "heal_begin" ",\"t0\":$t0"

  # 0) Missing next binary → long-budget npm ci BEFORE short heal timeout.
  if [[ ! -x "$NEXT_BIN" ]]; then
    echo "[$(date -Iseconds)] next binary missing — ensure-next-deps (budget ${ENSURE_TIMEOUT_SEC}s)" >>"$LOG"
    write_hb "ensure_next_deps" ",\"t0\":$t0"
    timeout "$ENSURE_TIMEOUT_SEC" bash "$ROOT/scripts/ensure-next-deps.sh" 8>&- >>"$LOG" 2>&1 \
      || echo "[$(date -Iseconds)] ensure-next-deps exit=$?" >>"$LOG"
    write_hb "ensure_next_done" ",\"nextOk\":$([[ -x "$NEXT_BIN" ]] && echo true || echo false)"
  fi

  # Close inherited flock FD so heal-bot-once children never hold our lock open
  timeout "$HEAL_TIMEOUT_SEC" bash "$ROOT/scripts/heal-bot-once.sh" 8>&- >>"$LOG" 2>&1 || true
  t1=$(date +%s)
  elapsed=$(( t1 - t0 ))
  write_hb "heal_done" ",\"t0\":$t0,\"t1\":$t1,\"elapsedSec\":$elapsed"
  echo "[$(date -Iseconds)] tick elapsed=${elapsed}s pid=$$ next=$([[ -x "$NEXT_BIN" ]] && echo ok || echo MISSING)" >>"$LOG"
  # Trim
  if [[ $(stat -c %s "$LOG" 2>/dev/null || echo 0) -gt 500000 ]]; then
    tail -c 120000 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  fi
  # Wall-clock jump (host/box sleep): if heal+work took >> expected, heal again now.
  # Normal heal is <90s (+ ensure may be long); if wall advanced >15 min after ensure, re-heal.
  jump_limit=300
  [[ ! -x "$NEXT_BIN" ]] && jump_limit=900
  if (( elapsed > jump_limit )); then
    echo "[$(date -Iseconds)] WALL_CLOCK_JUMP elapsed=${elapsed}s — immediate re-heal" >>"$LOG"
    write_hb "wall_jump_reheal" ",\"elapsedSec\":$elapsed"
    continue
  fi
  # Sleep in short slices so a mid-sleep freeze still re-heals within ~30s of wake
  remain=120
  while (( remain > 0 )); do
    slice=$(( remain < 30 ? remain : 30 ))
    s0=$(date +%s)
    sleep "$slice"
    s1=$(date +%s)
    slept=$(( s1 - s0 ))
    if (( slept > slice + 120 )); then
      echo "[$(date -Iseconds)] WALL_CLOCK_JUMP during sleep expected=${slice}s got=${slept}s — immediate re-heal" >>"$LOG"
      write_hb "wall_jump_sleep" ",\"expected\":$slice,\"got\":$slept"
      remain=0
      break
    fi
    remain=$(( remain - slice ))
    write_hb "sleeping" ",\"remainSec\":$remain"
  done
done
