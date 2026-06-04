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
| `scripts/local-review.sh` | No-GitHub-Actions fallback: poll a repo for new/updated PRs and run the reviewer locally; defaults to `deep` for first seen PR heads and `gate` for later pushes to the same PR. |
| `.github/workflows/ai-review.yml` | This repo's own PR review workflow (also serves as a working example). |
| `templates/consumer-ai-review.yml` | Drop into a **product repo** `.github/workflows/` to get AI review on PRs. |
| `templates/consumer-ci.yml` | The **non-AI gate** (typecheck/test/lint/eval) a product repo must run — the real safety net. |
| `BOOTSTRAP.md` | How to adopt this in a new or existing product repo. |
| `ADOPT-PROMPT.md` | Copy-paste prompt for asking an agent to adopt this workflow in another product repo. |

## Core principle (don't forget this)

**Source of truth = git + GitHub (PRs, comments, CI status). Files in this repo and any `pr_log.jsonl` are derived/regenerable, never hand-maintained state.** The moment something requires a human or AI to "remember to update it", it drifts. Push state onto tools that enforce it.

## Cost: subscription vs metered API

The reviewer has two backends so you don't have to pay metered API for everything:

- **`--backend claude-cli`** (default for `local-review.sh`): shells out to `claude -p` and uses your **Claude subscription (Pro/Max)** — no metered API key. Best run **locally** or on a **persistent self-hosted runner** where Claude Code is logged in. This is the cheapest path for a startup already paying for Max.
- **`--backend api`** (used by the GitHub Actions templates): Anthropic Messages API, metered key. Needed for **ephemeral CI runners** (they can't hold an interactive subscription login).

Practical split for a cost-conscious team:
- **Non-AI gate (typecheck/test/lint/eval) needs NO key** and runs free in Actions — that's the real safety net.
- **AI review locally via `claude-cli`** (subscription) while volume is low / you trigger it yourself.
- Add the **metered API key only when you want fully-unattended CI review**. Cost is small: one ~400-line-diff review is a few cents (checklist is prompt-cached). Control it: only non-draft PRs, keep `MAX_DIFF_CHARS` bounded, optionally a cheaper model for first pass.

## Large PR diff handling

`scripts/ai-review.mjs` first tries the normal combined PR diff. If that diff exceeds `MAX_DIFF_CHARS` (default `200000`), it uses GitHub's PR files API and reviews file patches in batches under the same cap instead of approving a truncated diff. File batching is not GitHub-order greedy anymore: security / policy / HTTP handler / auth / RLS / migration / source files are reviewed before tests and docs so the highest-value paths land in the earliest batches.

In `REVIEW_MODE=deep`, large file-batched PRs also run a bounded **cross-batch synthesis pass** over the batch summaries plus critical file patches. This pass is meant to catch cross-file/global invariant issues that per-batch context can miss. It does not run in `gate` / `confirm-fixes` mode by default, because follow-up reviews should be cheaper and focused.

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

# Follow-up after fixes: blockers, regressions, previous findings still open.
REVIEW_MODE=gate MAX_FINDINGS=5 node scripts/ai-review.mjs --repo OWNER/REPO --pr PR_NUMBER

# Strictly confirm the previous findings/fixes; do not re-review the whole PR.
REVIEW_MODE=confirm-fixes MAX_FINDINGS=5 node scripts/ai-review.mjs --repo OWNER/REPO --pr PR_NUMBER
```

`gate` and `confirm-fixes` read the previous review state from the living PR comment first, then from `PR_LOG_PATH` if available. This turns follow-up review into an explicit tool behavior instead of relying on the operator to ignore fresh low advisory findings.

Use `REVIEW_PROFILE=pilot_minimal` for temporary/pilot paths where the goal is a fast usable validation, not production hardening:

```bash
REVIEW_MODE=gate REVIEW_PROFILE=pilot_minimal MAX_FINDINGS=5 \
  node scripts/ai-review.mjs --repo OWNER/REPO --pr PR_NUMBER
```

`pilot_minimal` still checks the safety floor: main path can run, obvious crashes/races/resource leaks, auth/tenant boundaries, secret/PII/live URL leakage, fail-closed behavior, minimum tests, and honest implemented/partial/not-production labeling. It deprioritizes long-term architecture polish, product-scale concurrency/lifecycle, and low-value ergonomics.

For GitHub Actions, the consumer template uses the PR label `review:pilot-minimal` to request that profile on a single PR. Do not set `REVIEW_PROFILE` as a sticky repository variable; that silently downgrades all future reviews.

## Two boundaries that must hold

- **AI review is additive; the non-AI gate is the safety net.** typecheck/test/lint/eval-gate run independently of any AI judgment. If the AI reviewer misses something, the gate still stands.
- **Auto-trigger review: yes. Auto-merge: no.** Merge keeps a human gate, especially for security / irreversible / architectural changes.
