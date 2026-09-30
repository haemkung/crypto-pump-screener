#!/usr/bin/env bash
# Copy live early-tiers (and learning-insights) into Pages static paths.
# Used locally after daemon writes, and by GitHub Actions after a successful fetch.
# Does NOT commit/push unless PUBLISH_GIT_PUSH=1 (Actions sets this).
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
SRC_EARLY="${1:-$ROOT/data/early-tiers.json}"
SRC_LEARN="${2:-$ROOT/data/learning-insights.json}"
OUT_PUBLIC="$ROOT/pages-spa/public/data"
OUT_DOCS="$ROOT/docs/data"
mkdir -p "$OUT_PUBLIC" "$OUT_DOCS"

if [[ ! -f "$SRC_EARLY" ]]; then
  echo "missing $SRC_EARLY" >&2
  exit 1
fi

# Reject soft-fail / empty updatedAt bodies so we never overwrite a good static file
if ! jq -e '(.updatedAt | type == "string") and (.updatedAt | length > 0) and ((.meta.softFail // false) | not)' "$SRC_EARLY" >/dev/null 2>&1; then
  echo "skip: source not a usable last-good (softFail or no updatedAt)" >&2
  exit 0
fi

publishedAt="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
tmp="$(mktemp)"
jq --arg publishedAt "$publishedAt" --arg source "${PUBLISH_SOURCE:-local-box}" \
  '.meta = ((.meta // {}) + {source:$source, publishedAt:$publishedAt, pagesStatic:true})' \
  "$SRC_EARLY" >"$tmp"
cp -f "$tmp" "$OUT_PUBLIC/early-tiers.json"
# docs/ may be rebuilt by vite (emptyOutDir) — keep a copy that pages:build can re-copy,
# and also write docs/data for direct Pages serving between SPA rebuilds.
mkdir -p "$OUT_DOCS"
cp -f "$tmp" "$OUT_DOCS/early-tiers.json"
rm -f "$tmp"

if [[ -f "$SRC_LEARN" ]]; then
  cp -f "$SRC_LEARN" "$OUT_PUBLIC/learning-insights.json"
  cp -f "$SRC_LEARN" "$OUT_DOCS/learning-insights.json"
fi

SRC_COACH="${3:-$ROOT/data/coach-notes.json}"
if [[ -f "$SRC_COACH" ]]; then
  tmpc="$(mktemp)"
  jq '{notes: (.notes[-30:] // []), total: ((.notes // []) | length), meta: {pagesStatic:true, source:("'"${PUBLISH_SOURCE:-local-box}"'")}, disclaimerTh: "โน้ตโค้ชเป็น heuristic หลังเกรด — ไม่ใช่คำแนะนำการลงทุน"}' "$SRC_COACH" >"$tmpc" 2>/dev/null     || cp -f "$SRC_COACH" "$tmpc"
  cp -f "$tmpc" "$OUT_PUBLIC/coach-notes.json"
  cp -f "$tmpc" "$OUT_DOCS/coach-notes.json"
  rm -f "$tmpc"
fi

echo "published early-tiers updatedAt=$(jq -r .updatedAt "$OUT_DOCS/early-tiers.json") -> docs/data + pages-spa/public/data"

if [[ "${PUBLISH_GIT_PUSH:-0}" == "1" ]]; then
  git add docs/data/early-tiers.json docs/data/learning-insights.json docs/data/coach-notes.json \
    pages-spa/public/data/early-tiers.json pages-spa/public/data/learning-insights.json pages-spa/public/data/coach-notes.json 2>/dev/null || true
  if git diff --cached --quiet; then
    echo "no git changes"
    exit 0
  fi
  git -c user.name="cps-last-good-bot" -c user.email="cps-last-good-bot@users.noreply.github.com" \
    commit -m "chore: refresh Pages last-good early-tiers ($(jq -r .updatedAt "$OUT_DOCS/early-tiers.json"))" || true
  git push origin HEAD 2>&1 | tail -20
fi
exit 0
