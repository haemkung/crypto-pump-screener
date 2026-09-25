#!/usr/bin/env bash
# Idempotent boot/start: bring the whole bot up (safe to run any time, any number of times).
#   bash scripts/start-all.sh [--quiet]
# Starts (only if not already running): watchdog → which ensures supervise-bot-upstream.sh
# (Next :3000 + cloudflared tunnel + early-ignition daemon) and supervise-local-scheduler.sh.
# local-scheduler re-runs this every 5 min, so the watchdog and the scheduler supervise each other.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Load local secrets (gitignored) into env for child processes — never echo values
if [[ -f "$ROOT/.env.secrets" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env.secrets"
  set +a
fi
cd "$ROOT" || exit 1
mkdir -p logs logs/bot-upstream logs/early-ignition
QUIET=0; [[ "${1:-}" == "--quiet" ]] && QUIET=1
say() { (( QUIET )) || echo "$*"; }
[[ -z "${TELEGRAM_BOT_TOKEN:-}" ]] && say "warning: TELEGRAM_BOT_TOKEN not set in this environment (Telegram disabled for processes started now)"
start_detached() { setsid nohup bash "$1" >>"$2" 2>&1 </dev/null & }
if pgrep -f "scripts/supervise-bot-upstream.sh" >/dev/null; then say "supervise-bot-upstream: running"; else say "supervise-bot-upstream: starting"; start_detached scripts/supervise-bot-upstream.sh logs/bot-upstream/nohup.out; fi
if pgrep -f "scripts/supervise-local-scheduler.sh" >/dev/null; then say "local-scheduler: running"; else say "local-scheduler: starting"; start_detached scripts/supervise-local-scheduler.sh logs/local-scheduler.nohup.out; fi
if flock -n /tmp/crypto-pump-watchdog.lock true 2>/dev/null; then say "watchdog: starting"; start_detached scripts/watchdog.sh logs/watchdog.nohup.out; else say "watchdog: running"; fi
# best effort: survive a box reboot if cron exists
if command -v crontab >/dev/null 2>&1 && ! crontab -l 2>/dev/null | grep -q "start-all.sh"; then
  (crontab -l 2>/dev/null; echo "@reboot cd $ROOT && bash scripts/start-all.sh --quiet") | crontab - 2>/dev/null && say "cron @reboot installed"
fi
exit 0
