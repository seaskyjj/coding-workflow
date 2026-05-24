# Bootstrap — adopt coding-workflow in a product repo

## 0. Host this repo
Push `coding-workflow` to GitHub (e.g. `seaskyjj/coding-workflow`). Product repos reference it by name.

## 1. Local smoke (no Actions, no metered API key — uses your Claude subscription)
Requires `claude` (Claude Code) logged in with your Pro/Max plan, and `gh` authed.
```bash
# review one existing PR via subscription (claude-cli backend):
node /path/to/coding-workflow/scripts/ai-review.mjs --backend claude-cli --repo owner/name --pr 123
# poll for new PRs (defaults to claude-cli = subscription):
/path/to/coding-workflow/scripts/local-review.sh owner/name 120
```
To use the metered API instead (e.g. testing the CI path): `REVIEW_BACKEND=api ANTHROPIC_API_KEY=sk-ant-... node .../ai-review.mjs --repo ... --pr ...`.
This posts/updates one review comment on the PR and appends a `pr_log.jsonl` line.

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
