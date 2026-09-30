#!/usr/bin/env bash
# Best-effort reboot persistence for start-all. Never fails the caller hard.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MARKER="$ROOT/logs/boot-persist.status.json"
mkdir -p "$ROOT/logs"
installed=()

# 1) crontab @reboot + */2 heal (if crontab works)
if command -v crontab >/dev/null 2>&1; then
  existing="$(crontab -l 2>/dev/null || true)"
  line_reboot="@reboot cd $ROOT && /usr/bin/flock -n /tmp/crypto-pump-boot.lock bash scripts/start-all.sh --quiet >>logs/boot-reboot.log 2>&1"
  line_heal="*/2 * * * * cd $ROOT && /usr/bin/timeout 90 bash scripts/heal-bot-once.sh >>logs/heal-once/cron.log 2>&1"
  new="$existing"
  echo "$existing" | grep -qF "scripts/start-all.sh" || new="${new}"$'\n'"${line_reboot}"
  echo "$existing" | grep -qF "heal-bot-once.sh" || new="${new}"$'\n'"${line_heal}"
  if [[ "$new" != "$existing" ]]; then
    printf '%s\n' "$new" | crontab - 2>/dev/null && installed+=("crontab") || true
  else
    installed+=("crontab-present")
  fi
fi

# 2) Drop a user systemd unit if systemd --user works
if command -v systemctl >/dev/null 2>&1 && systemctl --user status >/dev/null 2>&1; then
  unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$unit_dir"
  cat >"$unit_dir/cps-start-all.service" <<UNIT
[Unit]
Description=Crypto pump screener start-all
After=default.target

[Service]
Type=oneshot
WorkingDirectory=$ROOT
ExecStart=/bin/bash $ROOT/scripts/start-all.sh --quiet
RemainAfterExit=yes

[Install]
WantedBy=default.target
UNIT
  cat >"$unit_dir/cps-heal.timer" <<UNIT
[Unit]
Description=CPS heal every 2 min

[Timer]
OnBootSec=30
OnUnitActiveSec=120
AccuracySec=30
Unit=cps-heal.service

[Install]
WantedBy=timers.target
UNIT
  cat >"$unit_dir/cps-heal.service" <<UNIT
[Unit]
Description=CPS heal-bot-once

[Service]
Type=oneshot
WorkingDirectory=$ROOT
ExecStart=/usr/bin/timeout 90 /bin/bash $ROOT/scripts/heal-bot-once.sh
UNIT
  systemctl --user daemon-reload 2>/dev/null || true
  systemctl --user enable --now cps-start-all.service 2>/dev/null && installed+=("systemd-user-start") || true
  systemctl --user enable --now cps-heal.timer 2>/dev/null && installed+=("systemd-user-heal") || true
fi

# 3) Always ensure the independent ticker is running now
if ! pgrep -f "scripts/independent-heal-ticker.sh" >/dev/null 2>&1; then
  setsid nohup bash "$ROOT/scripts/independent-heal-ticker.sh" >>"$ROOT/logs/heal-once/independent-ticker.nohup.out" 2>&1 </dev/null &
  installed+=("independent-ticker-started")
else
  installed+=("independent-ticker-running")
fi

jq -nc --arg at "$(date -Iseconds)" --argjson methods "$(printf '%s\n' "${installed[@]:-none}" | jq -R . | jq -s .)" \
  '{at:$at,methods:$methods}' >"$MARKER" 2>/dev/null || \
  echo "{\"at\":\"$(date -Iseconds)\",\"methods\":\"${installed[*]}\"}" >"$MARKER"
echo "boot-persist: ${installed[*]:-none}"
exit 0
