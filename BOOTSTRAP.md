# Bootstrap — adopt coding-workflow in a product repo

## 0. Host this repo
Push `coding-workflow` to GitHub (e.g. `seaskyjj/coding-workflow`). Product repos reference it by name.

## 1. Local smoke (no Actions, no metered API key — uses a logged-in CLI subscription)
Requires `gh` plus the selected reviewer CLI logged in (`codex` for `codex-cli`, `claude` for `claude-cli`).
```bash
# Review the current product-repo PR via subscription CLI.
# Default assumes Claude implemented the PR, so Codex/ChatGPT reviews it.
# Set REVIEW_BACKEND=claude-cli when Codex implemented the PR.
# Run inside the product repo; override CODING_WORKFLOW if the tooling checkout
# is not at $HOME/Programs/coding-workflow.
REPO_ROOT="$(git rev-parse --show-toplevel)"
REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)"
PR="$(gh pr view --json number --jq .number 2>/dev/null || true)"
CODING_WORKFLOW="${CODING_WORKFLOW:-$HOME/Programs/coding-workflow}"
AI_REVIEW_SCRIPT="$CODING_WORKFLOW/scripts/ai-review.mjs"
REVIEW_BACKEND="${REVIEW_BACKEND:-codex-cli}"
REVIEW_KIND="${REVIEW_KIND:-code}"

if [ ! -f "$AI_REVIEW_SCRIPT" ]; then
  echo "ai-review.mjs not found; skipping local AI review. CODING_WORKFLOW=$CODING_WORKFLOW"
elif [ -z "$REPO" ]; then
  echo "No GitHub repo found for this checkout; skipping local AI review."
elif [ -z "$PR" ]; then
  echo "No open PR found for the current branch; skipping local AI review."
elif [ "$REVIEW_BACKEND" = "codex-cli" ] && ! { command -v codex >/dev/null && codex --version >/dev/null 2>&1; }; then
  echo "codex CLI unavailable; set REVIEW_BACKEND=claude-cli or run manual review."
elif [ "$REVIEW_BACKEND" = "claude-cli" ] && ! { command -v claude >/dev/null && claude --version >/dev/null 2>&1; }; then
  echo "claude CLI unavailable; set REVIEW_BACKEND=codex-cli or run manual review."
elif [ "$REVIEW_BACKEND" = "api" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "ANTHROPIC_API_KEY missing; set REVIEW_BACKEND=codex-cli/claude-cli or add the key only after explicit opt-in."
else
  REVIEW_MODE="${REVIEW_MODE:-deep}" \
  REVIEW_PROFILE="${REVIEW_PROFILE:-standard}" \
  MAX_FINDINGS="${MAX_FINDINGS:-12}" \
  REVIEW_BACKEND="$REVIEW_BACKEND" \
  REVIEW_KIND="$REVIEW_KIND" \
  REVIEWER_OVERLAY="$REPO_ROOT/reviewer-overlay.md" \
  PR_LOG_PATH="${TMPDIR:-/tmp}/coding-workflow-pr-log.local.jsonl" \
  node "$AI_REVIEW_SCRIPT" --backend "$REVIEW_BACKEND" --review-kind "$REVIEW_KIND" --repo "$REPO" --pr "$PR"
fi

# Poll for new PRs. Default here assumes Claude implemented the PR, so Codex reviews it.
# Set REVIEW_BACKEND=claude-cli when Codex implemented the PR. Without an explicit
# REVIEW_MODE override, the poller uses deep for the first seen head of a PR and
# confirm-fixes for later pushes to the same PR.
REPO_ROOT="$(git rev-parse --show-toplevel)"
REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)"
CODING_WORKFLOW="${CODING_WORKFLOW:-$HOME/Programs/coding-workflow}"
LOCAL_REVIEW_SCRIPT="$CODING_WORKFLOW/scripts/local-review.sh"
REVIEW_BACKEND="${REVIEW_BACKEND:-codex-cli}"
if [ ! -f "$LOCAL_REVIEW_SCRIPT" ]; then
  echo "local-review.sh not found; skipping poller. CODING_WORKFLOW=$CODING_WORKFLOW"
elif [ -z "$REPO" ]; then
  echo "No GitHub repo found for this checkout; skipping poller."
elif [ "$REVIEW_BACKEND" = "codex-cli" ] && ! { command -v codex >/dev/null && codex --version >/dev/null 2>&1; }; then
  echo "codex CLI unavailable; set REVIEW_BACKEND=claude-cli or REVIEW_BACKEND=api before running the poller."
elif [ "$REVIEW_BACKEND" = "claude-cli" ] && ! { command -v claude >/dev/null && claude --version >/dev/null 2>&1; }; then
  echo "claude CLI unavailable; set REVIEW_BACKEND=codex-cli or REVIEW_BACKEND=api before running the poller."
elif [ "$REVIEW_BACKEND" = "api" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "ANTHROPIC_API_KEY missing; skipping API poller unless the team explicitly opts into metered review."
else
  REVIEW_PROFILE="${REVIEW_PROFILE:-standard}" \
  REVIEW_BACKEND="$REVIEW_BACKEND" \
  REVIEWER_OVERLAY="$REPO_ROOT/reviewer-overlay.md" \
  PR_LOG_PATH="${TMPDIR:-/tmp}/coding-workflow-pr-log.local.jsonl" \
  LOCAL_REVIEW_STATE="${TMPDIR:-/tmp}/coding-workflow-local-review-state" \
  "$LOCAL_REVIEW_SCRIPT" "$REPO" 120
fi
```
To use the metered API instead for an explicit manual run: `REVIEW_BACKEND=api ANTHROPIC_API_KEY=sk-ant-... node .../ai-review.mjs --repo ... --pr ...`.
This posts/updates one review comment on the PR and appends a `pr_log.jsonl` line.

For a large PR, inspect how the reviewer will split the diff before spending a review call:
```bash
node "$AI_REVIEW_SCRIPT" --repo "$REPO" --pr "$PR" --print-diff-plan
```

Use explicit review modes to control review cost:
```bash
# First pass: broad checklist/overlay discovery, capped at 10-12 findings.
REVIEW_MODE=deep MAX_FINDINGS=12 node "$AI_REVIEW_SCRIPT" --repo "$REPO" --pr "$PR"

# Development/fix loop: verify previous findings against the incremental diff.
REVIEW_MODE=confirm-fixes MAX_FINDINGS=5 node "$AI_REVIEW_SCRIPT" --repo "$REPO" --pr "$PR"

# Large feature deliverable check: blockers, regressions and high-value risks.
REVIEW_MODE=gate MAX_FINDINGS=5 node "$AI_REVIEW_SCRIPT" --repo "$REPO" --pr "$PR"

# Final merge/release candidate: run broad discovery again.
REVIEW_MODE=deep MAX_FINDINGS=12 node "$AI_REVIEW_SCRIPT" --repo "$REPO" --pr "$PR"

# Temporary pilot validation: keep the safety floor, skip production-polish hunting.
REVIEW_MODE=gate REVIEW_PROFILE=pilot_minimal MAX_FINDINGS=5 node "$AI_REVIEW_SCRIPT" --repo "$REPO" --pr "$PR"
```

For `gate` and `confirm-fixes`, the reviewer uses the previous review state's `headSha` and reviews only `previousReviewedHead...currentHead` plus previous findings. `confirm-fixes` also includes bounded current-file context around previous finding locations. If no previous `headSha` exists, these modes fail closed with `needs_human`.

Use `REVIEW_KIND` to choose what is reviewed (orthogonal to mode/profile):
```bash
# Default: code-diff review against reviewer/CHECKLIST.md.
node "$AI_REVIEW_SCRIPT" --repo "$REPO" --pr "$PR"

# Proposal/design review against reviewer/PROPOSAL-CHECKLIST.md — for ADRs, design docs,
# investigation write-ups, and next-step direction docs (pressure-tests reasoning, not prose).
REVIEW_KIND=proposal node "$AI_REVIEW_SCRIPT" --repo "$REPO" --pr "$PR"

# No-PR local diff (prints JSON; writes no comment/log). Empty or >MAX_DIFF_CHARS → needs_human.
REVIEW_KIND=proposal node "$AI_REVIEW_SCRIPT" --diff-file /tmp/direction.diff
```
On the same PR, code and proposal reviews keep separate living comments / `pr_log` entries (code uses the `default` marker, proposal defaults to `proposal`); only same-kind previous state is reused. Set a distinct `REVIEW_COMMENT_ID` to run two reviews of the same kind side by side.

For GitHub Actions, the template intentionally skips metered API review by default. Request `pilot_minimal` with the PR label `review:pilot-minimal` as documentation of intent, but do not set it as a repository-wide default.

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
1. If `coding-workflow` is private, add `CODING_WORKFLOW_TOKEN`; no Anthropic API key is required for the default Action.
2. Copy `templates/consumer-ai-review.yml` → product `.github/workflows/ai-review.yml`; set the `repository:` field to your coding-workflow location.
3. Copy `templates/consumer-ci.yml` → product `.github/workflows/ci.yml`; adjust commands (typecheck/lint/test + project gates like eval / visual).
4. Open a PR — GitHub Actions run the no-key workflow checks and non-AI gate. Run local independent CLI review (`codex-cli` for Claude-implemented PRs, `claude-cli` for Codex-implemented PRs) for the deep / confirm-fixes / gate AI rounds.

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
