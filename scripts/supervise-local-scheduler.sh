#!/usr/bin/env bash
cd "$(dirname "${BASH_SOURCE[0]}")/.."
while true; do bash scripts/local-scheduler.sh; sleep 5; done
