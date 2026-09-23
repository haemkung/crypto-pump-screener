#!/usr/bin/env bash
# Backward-compatible entrypoint: now supervises BOTH named tunnel AND local Next.
# Prefer: bash scripts/supervise-bot-upstream.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "$ROOT/scripts/supervise-bot-upstream.sh"
