#!/usr/bin/env bash
# local-review.sh — no-GitHub-Actions fallback: poll a repo for open PRs and run the
# AI reviewer whenever a PR's head sha changes (new PR or new push). Advisory only.
#
# Usage:
#   ANTHROPIC_API_KEY=... ./scripts/local-review.sh owner/name [interval_seconds]
#
# Requires: gh (authenticated), node 18+, ANTHROPIC_API_KEY.
# State (reviewed head sha per PR) is kept in .local-review-state so restarts don't re-review.
set -euo pipefail

REPO="${1:?usage: local-review.sh owner/name [interval_seconds]}"
INTERVAL="${2:-120}"
HERE="$(cd "$(dirname "$0")" && pwd)"
STATE_FILE="${LOCAL_REVIEW_STATE:-.local-review-state}"
touch "$STATE_FILE"

echo "polling $REPO every ${INTERVAL}s for open PRs (Ctrl-C to stop)"
while true; do
  # number + headRefOid for every open PR
  while IFS=$'\t' read -r num sha; do
    [ -z "${num:-}" ] && continue
    key="${num}:${sha}"
    if ! grep -qx "$key" "$STATE_FILE"; then
      echo "[$(date +%H:%M:%S)] reviewing PR #${num} @ ${sha:0:7}"
      if node "$HERE/ai-review.mjs" --repo "$REPO" --pr "$num"; then
        echo "$key" >> "$STATE_FILE"
      else
        echo "  review failed for #${num}; will retry next cycle"
      fi
    fi
  done < <(gh pr list --repo "$REPO" --state open --limit 100 --json number,headRefOid \
             --jq '.[] | [.number, .headRefOid] | @tsv')
  sleep "$INTERVAL"
done
