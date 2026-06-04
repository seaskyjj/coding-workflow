# Bootstrap — adopt coding-workflow in a product repo

## 0. Host this repo
Push `coding-workflow` to GitHub (e.g. `seaskyjj/coding-workflow`). Product repos reference it by name.

## 1. Local smoke (no Actions, no metered API key — uses your Claude subscription)
Requires `claude` (Claude Code) logged in with your Pro/Max plan, and `gh` authed.
```bash
# Review the current product-repo PR via subscription (claude-cli backend).
# Run inside the product repo; override CODING_WORKFLOW if the tooling checkout
# is not at $HOME/Programs/coding-workflow.
REPO_ROOT="$(git rev-parse --show-toplevel)"
REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)"
PR="$(gh pr view --json number --jq .number 2>/dev/null || true)"
CODING_WORKFLOW="${CODING_WORKFLOW:-$HOME/Programs/coding-workflow}"
AI_REVIEW_SCRIPT="$CODING_WORKFLOW/scripts/ai-review.mjs"

if [ ! -f "$AI_REVIEW_SCRIPT" ]; then
  echo "ai-review.mjs not found; skipping local Claude review. CODING_WORKFLOW=$CODING_WORKFLOW"
elif [ -z "$REPO" ]; then
  echo "No GitHub repo found for this checkout; skipping local Claude review."
elif [ -z "$PR" ]; then
  echo "No open PR found for the current branch; skipping local Claude review."
elif command -v claude >/dev/null && claude --version >/dev/null 2>&1; then
  REVIEW_MODE="${REVIEW_MODE:-deep}" \
  REVIEW_PROFILE="${REVIEW_PROFILE:-standard}" \
  MAX_FINDINGS="${MAX_FINDINGS:-12}" \
  REVIEW_COMMENT_ID=claude-cli \
  REVIEWER_OVERLAY="$REPO_ROOT/reviewer-overlay.md" \
  PR_LOG_PATH="${TMPDIR:-/tmp}/coding-workflow-pr-log.local.jsonl" \
  node "$AI_REVIEW_SCRIPT" --backend claude-cli --repo "$REPO" --pr "$PR"
else
  echo "claude CLI unavailable; rely on GitHub Action or manual review."
fi

# Poll for new PRs (defaults to claude-cli = subscription). Without an explicit
# REVIEW_MODE override, the poller uses deep for the first seen head of a PR and
# gate for later pushes to the same PR.
REPO_ROOT="$(git rev-parse --show-toplevel)"
REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)"
CODING_WORKFLOW="${CODING_WORKFLOW:-$HOME/Programs/coding-workflow}"
LOCAL_REVIEW_SCRIPT="$CODING_WORKFLOW/scripts/local-review.sh"
if [ ! -f "$LOCAL_REVIEW_SCRIPT" ]; then
  echo "local-review.sh not found; skipping poller. CODING_WORKFLOW=$CODING_WORKFLOW"
elif [ -z "$REPO" ]; then
  echo "No GitHub repo found for this checkout; skipping poller."
elif command -v claude >/dev/null && claude --version >/dev/null 2>&1; then
  REVIEW_PROFILE="${REVIEW_PROFILE:-standard}" \
  REVIEW_COMMENT_ID=claude-cli \
  REVIEWER_OVERLAY="$REPO_ROOT/reviewer-overlay.md" \
  PR_LOG_PATH="${TMPDIR:-/tmp}/coding-workflow-pr-log.local.jsonl" \
  LOCAL_REVIEW_STATE="${TMPDIR:-/tmp}/coding-workflow-local-review-state" \
  "$LOCAL_REVIEW_SCRIPT" "$REPO" 120
else
  echo "claude CLI unavailable; skipping poller unless REVIEW_BACKEND=api is configured manually."
fi
```
To use the metered API instead (e.g. testing the CI path): `REVIEW_BACKEND=api ANTHROPIC_API_KEY=sk-ant-... node .../ai-review.mjs --repo ... --pr ...`.
This posts/updates one review comment on the PR and appends a `pr_log.jsonl` line.

For a large PR, inspect how the reviewer will split the diff before spending a review call:
```bash
node "$AI_REVIEW_SCRIPT" --repo "$REPO" --pr "$PR" --print-diff-plan
```

Use explicit review modes to control review cost:
```bash
# First pass: broad checklist/overlay discovery, capped at 10-12 findings.
REVIEW_MODE=deep MAX_FINDINGS=12 node "$AI_REVIEW_SCRIPT" --repo "$REPO" --pr "$PR"

# Follow-up: previous fixes, blockers, regressions and newly introduced high-value issues.
REVIEW_MODE=gate MAX_FINDINGS=5 node "$AI_REVIEW_SCRIPT" --repo "$REPO" --pr "$PR"

# Temporary pilot validation: keep the safety floor, skip production-polish hunting.
REVIEW_MODE=gate REVIEW_PROFILE=pilot_minimal MAX_FINDINGS=5 node "$AI_REVIEW_SCRIPT" --repo "$REPO" --pr "$PR"
```

For GitHub Actions, request `pilot_minimal` with the PR label `review:pilot-minimal`; do not set it as a repository-wide default.

If the plan or review says a file patch was omitted or oversized, inspect that file explicitly:
```bash
gh api "repos/$REPO/pulls/$PR/files" --paginate \
  --jq '.[] | select(.filename=="path/to/file.ts") | .patch'

gh pr checkout "$PR" --repo "$REPO"
BASE_REF="$(gh pr view "$PR" --repo "$REPO" --json baseRefName --jq .baseRefName)"
git diff "origin/$BASE_REF...HEAD" -- "path/to/file.ts"
```

Optional project rules: drop a `reviewer-overlay.md` at the **product-repo root** with repo-specific invariants — the reviewer appends it to the checklist automatically. (Do not put it under `.coding-workflow*`; that path is reserved for the tools checkout in CI.)

## 2. Turn on auto-review in the product repo (GitHub Actions)
1. In the product repo settings → Secrets: add `ANTHROPIC_API_KEY` (and `CODING_WORKFLOW_TOKEN` if this repo is private). Optional repo variable `ANTHROPIC_MODEL`.
2. Copy `templates/consumer-ai-review.yml` → product `.github/workflows/ai-review.yml`; set the `repository:` field to your coding-workflow location.
3. Copy `templates/consumer-ci.yml` → product `.github/workflows/ci.yml`; adjust commands (typecheck/lint/test + project gates like eval / visual).
4. Open a PR — the AI reviewer comments automatically; CI runs the non-AI gate.

## 3. Operating rules (see WORKFLOW.md)
- One capability per PR; leave `main` green; revertable.
- Every real-bug finding becomes a regression test **in the same PR**.
- Auto-review yes; **auto-merge no** — human approves merge, especially security/irreversible/architectural.

## 4. Analytics
`pr_log.jsonl` is a derived export — regenerate anytime, never hand-edit:
```bash
node scripts/pr-log.mjs --repo owner/name --backfill --out pr_log.jsonl
# then e.g.: jq -s 'group_by(.review.findings[].area)' ... , or load into pandas
```
Schema: `scripts/pr_log.schema.json`. Useful cuts: findings/PR, by area (authz/contract/policy/visual), finding→test conversion, review rounds, CI pass-rate.
