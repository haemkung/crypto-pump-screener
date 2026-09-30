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
script_running() {
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
if script_running "scripts/supervise-bot-upstream.sh"; then say "supervise-bot-upstream: running"; else say "supervise-bot-upstream: starting"; start_detached scripts/supervise-bot-upstream.sh logs/bot-upstream/nohup.out; fi
if script_running "scripts/supervise-local-scheduler.sh"; then say "local-scheduler: running"; else say "local-scheduler: starting"; start_detached scripts/supervise-local-scheduler.sh logs/local-scheduler.nohup.out; fi
if flock -n /tmp/crypto-pump-watchdog.lock true 2>/dev/null; then say "watchdog: starting"; start_detached scripts/watchdog.sh logs/watchdog.nohup.out; else say "watchdog: running"; fi
# Independent heal ticker (survives local-scheduler freezes on evaluate/alerts)
if script_running "scripts/independent-heal-ticker.sh"; then say "independent-heal-ticker: running"; else say "independent-heal-ticker: starting"; start_detached scripts/independent-heal-ticker.sh logs/heal-once/independent-ticker.nohup.out; fi
# Best-effort reboot persistence (crontab / systemd --user / ticker). Never blocks boot.
bash "$ROOT/scripts/install-boot-persist.sh" >/dev/null 2>&1 || true
# Ensure Next deps once at boot (non-blocking if already present)
if [[ ! -x "$ROOT/node_modules/.bin/next" ]]; then
  say "next missing — npm ci via ensure-next-deps"
  bash "$ROOT/scripts/ensure-next-deps.sh" || say "warning: ensure-next-deps failed"
fi
exit 0
