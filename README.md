# coding-workflow

Reusable, **lightweight** engineering + AI-collaboration workflow, extracted so it lives **outside** any single product repo.

It exists because process/orchestration tooling is cross-project and should not be copy-pasted into every product. Product repos consume it; they don't embed it.

## What's here

| Path | Purpose |
| --- | --- |
| `WORKFLOW.md` | The methodology: PR sizing, finding→test rule, source-of-truth vs derived, CI gate, repo-management, three-party roles. Read this first. |
| `reviewer/CHECKLIST.md` | The review lens — recurring bug classes (authz/tenant, contract drift, policy invariants, visual). What the AI reviewer is told to look for. |
| `reviewer/review-prompt.md` | Prompt template fed to the AI reviewer (references CHECKLIST). |
| `scripts/ai-review.mjs` | Self-contained reviewer: reads a PR diff, calls the **configured reviewer backend** (`claude-cli` subscription or `api`) with the checklist (+ optional project overlay), upserts one structured review comment, appends a `pr_log` record. |
| `scripts/pr-log.mjs` | Generate/append `pr_log.jsonl` from GitHub (`gh`). Derived export — regenerable, never hand-maintained. |
| `scripts/pr_log.schema.json` | Schema of one `pr_log.jsonl` record (for stats / validation). |
| `scripts/local-review.sh` | No-GitHub-Actions fallback: poll a repo for new/updated PRs and run the reviewer locally; defaults to `deep` for first seen PR heads and `confirm-fixes` for later pushes to the same PR. |
| `.github/workflows/ai-review.yml` | This repo's own no-key PR review workflow (also serves as a working example). |
| `templates/consumer-ai-review.yml` | Drop into a **product repo** `.github/workflows/` for no-key review workflow checks; local `claude-cli` remains the default AI review path. |
| `templates/consumer-ci.yml` | The **non-AI gate** (typecheck/test/lint/eval) a product repo must run — the real safety net. |
| `BOOTSTRAP.md` | How to adopt this in a new or existing product repo. |
| `ADOPT-PROMPT.md` | Copy-paste prompt for asking an agent to adopt this workflow in another product repo. |

## Core principle (don't forget this)

**Source of truth = git + GitHub (PRs, comments, CI status). Files in this repo and any `pr_log.jsonl` are derived/regenerable, never hand-maintained state.** The moment something requires a human or AI to "remember to update it", it drifts. Push state onto tools that enforce it.

## Cost: subscription vs metered API

The reviewer has two backends so you don't have to pay metered API for everything:

- **`--backend claude-cli`** (default for `local-review.sh`): shells out to `claude -p` and uses your **Claude subscription (Pro/Max)** — no metered API key. Best run **locally** or on a **persistent self-hosted runner** where Claude Code is logged in. This is the cheapest path for a startup already paying for Max.
- **`--backend api`**: Anthropic Messages API, metered key. It remains supported for explicit manual use, but the GitHub Actions templates intentionally skip API review by default.

Practical split for a cost-conscious team:
- **Non-AI gate (typecheck/test/lint/eval) needs NO key** and runs free in Actions — that's the real safety net.
- **AI review locally via `claude-cli`** (subscription) while volume is low / you trigger it yourself.
- Keep **GitHub Action API review disabled by default** while cost and review cadence are being tuned. If you later opt into fully unattended CI review, keep it explicit and bounded: only non-draft PRs, `MAX_DIFF_CHARS` capped, and a deliberate model choice.

## Large PR diff handling

`scripts/ai-review.mjs` first tries the normal combined PR diff. If that diff exceeds `MAX_DIFF_CHARS` (default `200000`), it uses GitHub's PR files API and reviews file patches in batches under the same cap instead of approving a truncated diff. File batching is not GitHub-order greedy anymore: security / policy / HTTP handler / auth / RLS / migration / source files are reviewed before tests and docs so the highest-value paths land in the earliest batches.

In `REVIEW_MODE=deep`, large file-batched PRs also run a bounded **cross-batch synthesis pass** over the batch summaries plus critical file patches. This pass is meant to catch cross-file/global invariant issues that per-batch context can miss. It does not run in `gate` / `confirm-fixes` mode by default, because follow-up reviews should be cheaper and focused.

In `REVIEW_MODE=gate` or `REVIEW_MODE=confirm-fixes`, the reviewer reads the previous `headSha` from the living PR comment first, then `PR_LOG_PATH`. It reviews only the incremental GitHub compare diff from `previousReviewedHead...currentHead` plus previous findings. `confirm-fixes` also adds bounded current-file context around previous finding locations so the model can verify the fix without receiving the whole PR diff again.

If a file has no API `patch` or a single file patch still exceeds the cap, the overall verdict is forced to `needs_human`; partial review must not yield `approve`.

Dry-run the batching plan without calling an AI backend or posting a comment:

```bash
node scripts/ai-review.mjs --repo OWNER/REPO --pr PR_NUMBER --print-diff-plan
```

Inspect one file patch directly when a review reports an omitted or oversized file:

```bash
gh api repos/OWNER/REPO/pulls/PR_NUMBER/files --paginate \
  --jq '.[] | select(.filename=="path/to/file.ts") | .patch'

gh pr checkout PR_NUMBER --repo OWNER/REPO
BASE_REF="${BASE_REF:-main}"
git diff "origin/$BASE_REF...HEAD" -- "path/to/file.ts"
```

## Review modes and profiles

Use review mode to keep first-pass discovery and follow-up confirmation from becoming the same expensive operation:

```bash
# First review after opening a PR: broad but capped discovery.
REVIEW_MODE=deep MAX_FINDINGS=12 node scripts/ai-review.mjs --repo OWNER/REPO --pr PR_NUMBER

# Development/fix loop after the first deep review: strictly confirm previous findings/fixes.
REVIEW_MODE=confirm-fixes MAX_FINDINGS=5 node scripts/ai-review.mjs --repo OWNER/REPO --pr PR_NUMBER

# Large feature deliverable check: blockers, regressions, previous findings still open.
REVIEW_MODE=gate MAX_FINDINGS=5 node scripts/ai-review.mjs --repo OWNER/REPO --pr PR_NUMBER

# Final merge/release candidate: broad review again.
REVIEW_MODE=deep MAX_FINDINGS=12 node scripts/ai-review.mjs --repo OWNER/REPO --pr PR_NUMBER
```

`gate` and `confirm-fixes` require previous review state with `headSha`; if it is missing, they fail closed with `needs_human`. This keeps follow-up review from silently falling back to a full broad review or approving without a known base. Run `deep` first or restore the prior review state before using them.

Use `REVIEW_PROFILE=pilot_minimal` for temporary/pilot paths where the goal is a fast usable validation, not production hardening:

```bash
REVIEW_MODE=gate REVIEW_PROFILE=pilot_minimal MAX_FINDINGS=5 \
  node scripts/ai-review.mjs --repo OWNER/REPO --pr PR_NUMBER
```

`pilot_minimal` still checks the safety floor: main path can run, obvious crashes/races/resource leaks, auth/tenant boundaries, secret/PII/live URL leakage, fail-closed behavior, minimum tests, and honest implemented/partial/not-production labeling. It deprioritizes long-term architecture polish, product-scale concurrency/lifecycle, and low-value ergonomics.

For GitHub Actions, the consumer template still recognizes the PR label `review:pilot-minimal` as documentation of intent, but it does not call the metered API reviewer by default. Do not set `REVIEW_PROFILE` as a sticky repository variable; that silently downgrades all future local/API reviews when the API step is re-enabled.

## Two boundaries that must hold

- **AI review is additive; the non-AI gate is the safety net.** typecheck/test/lint/eval-gate run independently of any AI judgment. If the AI reviewer misses something, the gate still stands.
- **Auto-trigger review: yes. Auto-merge: no.** Merge keeps a human gate, especially for security / irreversible / architectural changes.
