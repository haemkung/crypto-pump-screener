#!/usr/bin/env bash
# Start local Next as BOT_UPSTREAM (DISABLE_BOT_UPSTREAM=1). Prefer the dual supervisor.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export DISABLE_BOT_UPSTREAM=1
export BOT_ROLE=upstream
PORT="${UPSTREAM_NEXT_PORT:-3000}"
MODE="${UPSTREAM_NEXT_MODE:-dev}"
if [[ "$MODE" == "start" ]]; then
  exec npm run start
else
  exec npm run dev
fi
