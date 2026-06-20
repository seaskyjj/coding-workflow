---
name: coding-workflow-pr-review
description: Adopt or operate the reusable seaskyjj/coding-workflow engineering workflow in a product repository, including CI setup, reviewer overlay creation, local independent AI PR review via codex-cli/claude-cli/api, and proposal/design review. Use when the user asks to adopt coding-workflow, set up the PR review workflow, run or explain the AI review loop, create reviewer-overlay.md, or review a PR with the coding-workflow scripts.
---

# Coding Workflow PR Review

Use this as a thin operator layer over the `coding-workflow` repository. Do not copy or vendor its scripts into the product repo; always reference the tooling checkout and read its current docs before acting.

## Locate The Tooling

1. Set `CODING_WORKFLOW="${CODING_WORKFLOW:-$HOME/Programs/coding-workflow}"`.
2. If the current repo is `coding-workflow`, use it directly.
3. If `$CODING_WORKFLOW` is missing, clone or fetch `https://github.com/seaskyjj/coding-workflow` there unless the user gave a different tooling repo.
4. Before edits or reviews, read the current versions of:
   - `WORKFLOW.md`
   - `BOOTSTRAP.md`
   - `ADOPT-PROMPT.md`
   - `reviewer/CHECKLIST.md`
   - `reviewer/PROPOSAL-CHECKLIST.md`
   - `templates/consumer-ci.yml`
   - `templates/consumer-ai-review.yml`

## Adopt Into A Product Repo

Use the current `ADOPT-PROMPT.md` as the source of truth for the exact adoption task. Execute it inside the target product repo, preserving these boundaries:

- Open one PR; do not push directly to main.
- Add only consumer config to the product repo: tailored CI workflow, AI-review workflow, project-specific `reviewer-overlay.md`, and a small agent-instructions section if the repo has an agent instruction file.
- Tailor the non-AI CI gate to the real toolchain. Do not add fake, mock, or commented-in gates that do not pass.
- Keep GitHub Actions API AI review disabled unless the team explicitly opts into metered API review.
- Do not write secrets into the repo.
- Report human-only prerequisites separately.

## Run PR Review

Use the repo script rather than re-implementing review logic:

```bash
REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)"
PR="$(gh pr view --json number --jq .number 2>/dev/null || true)"
CODING_WORKFLOW="${CODING_WORKFLOW:-$HOME/Programs/coding-workflow}"
AI_REVIEW_SCRIPT="$CODING_WORKFLOW/scripts/ai-review.mjs"

REVIEW_BACKEND="${REVIEW_BACKEND:-codex-cli}"   # Claude implementer -> codex-cli; Codex implementer -> claude-cli.
REVIEW_KIND="${REVIEW_KIND:-code}"              # Use proposal for ADRs/design docs/investigations.

REVIEW_MODE="${REVIEW_MODE:-deep}" \
REVIEW_PROFILE="${REVIEW_PROFILE:-standard}" \
MAX_FINDINGS="${MAX_FINDINGS:-12}" \
REVIEW_BACKEND="$REVIEW_BACKEND" \
REVIEW_KIND="$REVIEW_KIND" \
REVIEWER_OVERLAY="$PWD/reviewer-overlay.md" \
PR_LOG_PATH="${TMPDIR:-/tmp}/coding-workflow-pr-log.local.jsonl" \
node "$AI_REVIEW_SCRIPT" --backend "$REVIEW_BACKEND" --review-kind "$REVIEW_KIND" --repo "$REPO" --pr "$PR"
```

Backend selection:

- Use `codex-cli` when Claude implemented the PR and Codex/ChatGPT should review it.
- Use `claude-cli` when Codex implemented the PR and Claude should review it.
- Use `api` only after explicit opt-in to metered Anthropic API review.
- If a selected CLI is unavailable or not logged in, report that status. Do not fabricate review results.

Review kind selection:

- Use `code` for normal code diffs.
- Use `proposal` for ADRs, design docs, investigation write-ups, methodology, knowledge, or next-step direction content.
- For mixed code and proposal PRs, run both kinds. They write separate review comments and `pr_log` entries.

## Invariants

- AI review posts or updates a PR comment; it does not auto-merge and does not replace non-AI CI.
- Real findings should become tests or executable invariants in the same PR where applicable.
- Keep `implemented`, `partial`, `mock`, `schema-only`, and `not implemented` distinct in code, docs, UI, and final reporting.
- If evidence is incomplete, oversized, or unavailable, fail closed with `needs_human` rather than approving partial context.
