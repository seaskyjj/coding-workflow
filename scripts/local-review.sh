#!/usr/bin/env bash
# local-review.sh — no-GitHub-Actions fallback: poll a repo for open PRs and run the
# AI reviewer whenever a PR's head sha changes (new PR or new push). Advisory only.
#
# Defaults to the claude-cli backend = your Claude subscription (Max), NO metered API key.
# Requires `claude` (Claude Code) installed and logged in. Override with REVIEW_BACKEND=api.
#
# Usage:
#   ./scripts/local-review.sh owner/name [interval_seconds]            # subscription (default)
#   REVIEW_BACKEND=api ANTHROPIC_API_KEY=... ./scripts/local-review.sh owner/name
#
# Requires: gh (authenticated), node 18+, and either `claude` CLI (default) or ANTHROPIC_API_KEY.
export REVIEW_BACKEND="${REVIEW_BACKEND:-claude-cli}"
# State (reviewed head sha per PR) is kept in .local-review-state so restarts don't re-review.
# First seen head defaults to deep; later pushes default to confirm-fixes. Run gate explicitly
# when a large feature point is ready for a deliverability check.
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
      mode="${REVIEW_MODE:-}"
      if [ -z "$mode" ]; then
        if grep -q "^${num}:" "$STATE_FILE"; then
          mode="confirm-fixes"
        else
          mode="deep"
        fi
      fi
      profile="${REVIEW_PROFILE:-standard}"
      findings="${MAX_FINDINGS:-}"
      if [ -z "$findings" ]; then
        if [ "$mode" = "deep" ] && [ "$profile" != "pilot_minimal" ]; then
          findings="12"
        else
          findings="5"
        fi
      fi
      echo "[$(date +%H:%M:%S)] reviewing PR #${num} @ ${sha:0:7} (${mode}/${profile}, max findings ${findings})"
      if REVIEW_MODE="$mode" REVIEW_PROFILE="$profile" MAX_FINDINGS="$findings" node "$HERE/ai-review.mjs" --repo "$REPO" --pr "$num"; then
        echo "$key" >> "$STATE_FILE"
      else
        echo "  review failed for #${num}; will retry next cycle"
      fi
    fi
  done < <(gh pr list --repo "$REPO" --state open --limit 100 --json number,headRefOid \
             --jq '.[] | [.number, .headRefOid] | @tsv')
  sleep "$INTERVAL"
done
