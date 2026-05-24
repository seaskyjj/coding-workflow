# Bootstrap — adopt coding-workflow in a product repo

## 0. Host this repo
Push `coding-workflow` to GitHub (e.g. `seaskyjj/coding-workflow`). Product repos reference it by name.

## 1. Local smoke (no Actions yet)
From the product repo (or anywhere with `gh` authed):
```bash
export ANTHROPIC_API_KEY=sk-ant-...
export ANTHROPIC_MODEL=claude-sonnet-4-5      # or your preferred model id
# review one existing PR:
node /path/to/coding-workflow/scripts/ai-review.mjs --repo owner/name --pr 123
# poll for new PRs (no-Actions fallback):
/path/to/coding-workflow/scripts/local-review.sh owner/name 120
```
This posts a review comment on the PR and appends a `pr_log.jsonl` line.

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
