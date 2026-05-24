# coding-workflow

Reusable, **lightweight** engineering + AI-collaboration workflow, extracted so it lives **outside** any single product repo.

It exists because process/orchestration tooling is cross-project and should not be copy-pasted into every product. Product repos consume it; they don't embed it.

## What's here

| Path | Purpose |
| --- | --- |
| `WORKFLOW.md` | The methodology: PR sizing, finding→test rule, source-of-truth vs derived, CI gate, repo-management, three-party roles. Read this first. |
| `reviewer/CHECKLIST.md` | The review lens — recurring bug classes (authz/tenant, contract drift, policy invariants, visual). What the AI reviewer is told to look for. |
| `reviewer/review-prompt.md` | Prompt template fed to the AI reviewer (references CHECKLIST). |
| `scripts/ai-review.mjs` | Self-contained reviewer: reads a PR diff, calls the Anthropic API with the checklist, posts a structured review comment, appends a `pr_log` record. |
| `scripts/pr-log.mjs` | Generate/append `pr_log.jsonl` from GitHub (`gh`). Derived export — regenerable, never hand-maintained. |
| `scripts/pr_log.schema.json` | Schema of one `pr_log.jsonl` record (for stats / validation). |
| `scripts/local-review.sh` | No-GitHub-Actions fallback: poll a repo for new/updated PRs and run the reviewer locally. |
| `.github/workflows/ai-review.yml` | This repo's own PR review workflow (also serves as a working example). |
| `templates/consumer-ai-review.yml` | Drop into a **product repo** `.github/workflows/` to get AI review on PRs. |
| `templates/consumer-ci.yml` | The **non-AI gate** (typecheck/test/lint/eval) a product repo must run — the real safety net. |
| `BOOTSTRAP.md` | How to adopt this in a new or existing product repo. |

## Core principle (don't forget this)

**Source of truth = git + GitHub (PRs, comments, CI status). Files in this repo and any `pr_log.jsonl` are derived/regenerable, never hand-maintained state.** The moment something requires a human or AI to "remember to update it", it drifts. Push state onto tools that enforce it.

## Two boundaries that must hold

- **AI review is additive; the non-AI gate is the safety net.** typecheck/test/lint/eval-gate run independently of any AI judgment. If the AI reviewer misses something, the gate still stands.
- **Auto-trigger review: yes. Auto-merge: no.** Merge keeps a human gate, especially for security / irreversible / architectural changes.
