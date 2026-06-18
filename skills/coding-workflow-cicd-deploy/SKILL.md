---
name: coding-workflow-cicd-deploy
description: Operate reusable local CI gates, GitHub check diagnostics, self-hosted runner planning, service-manager plans, and remote staging deploys through the coding-workflow repository.
---

# Coding Workflow CI/CD Deploy

Use this as a thin operator layer over the `coding-workflow` repository. Do not copy or vendor scripts into the product repo.

## Locate Tooling

1. Set `CODING_WORKFLOW="${CODING_WORKFLOW:-$HOME/Programs/coding-workflow}"`.
2. If the current repo is `coding-workflow`, use it directly.
3. If `$CODING_WORKFLOW` is missing, clone or fetch `https://github.com/seaskyjj/coding-workflow` there unless the user gave a different tooling repo.
4. Before acting, read the current versions of:
   - `WORKFLOW.md`
   - `BOOTSTRAP.md`
   - `CICD-DEPLOY-WORKFLOW-PROPOSAL.md`
   - `templates/consumer-local-gates.json`
   - `templates/consumer-deploy-staging.json`
   - `templates/consumer-self-hosted-runner-plan.md`

## Run Local PR Gate

Use the product repo's own `.coding-workflow/local-gates.json`:

```bash
CODING_WORKFLOW="${CODING_WORKFLOW:-$HOME/Programs/coding-workflow}"
node "$CODING_WORKFLOW/scripts/local-pr-gate.mjs" \
  --profile PROFILE_ID \
  --config .coding-workflow/local-gates.json \
  --output-dir "tmp/coding-workflow/local-pr-gate/PROFILE_ID" \
  --json
```

Dirty worktrees fail closed unless `--allow-dirty` is explicit. Missing env creates skipped/partial evidence, never covered/passed evidence.

## Diagnose GitHub Checks

```bash
REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)"
PR="$(gh pr view --json number --jq .number 2>/dev/null || true)"
CODING_WORKFLOW="${CODING_WORKFLOW:-$HOME/Programs/coding-workflow}"
node "$CODING_WORKFLOW/scripts/ci-diagnose-pr.mjs" \
  --repo "$REPO" \
  --pr "$PR" \
  --history-limit 20 \
  --json
```

Do not classify real product test failures as hosted runner unavailability. Do not treat intentional API AI review skips as product test failures.

## Plan Self-Hosted Runner

```bash
CODING_WORKFLOW="${CODING_WORKFLOW:-$HOME/Programs/coding-workflow}"
node "$CODING_WORKFLOW/scripts/self-hosted-runner-plan.mjs" \
  --diagnostics-json tmp/coding-workflow/ci-diagnostics/pr-123/ci-diagnostics.json \
  --local-gate-json tmp/coding-workflow/local-pr-gate/PROFILE/local-pr-gate.json \
  --local-ci-insufficient-note "Branch protection requires visible PR checks." \
  --target-host HOST \
  --runner-labels self-hosted,linux,x64 \
  --repo-scope OWNER/REPO
```

This produces a plan only. It never registers a runner and never writes GitHub runner tokens to disk.

## Deploy Staging

Dry-run first:

```bash
CODING_WORKFLOW="${CODING_WORKFLOW:-$HOME/Programs/coding-workflow}"
node "$CODING_WORKFLOW/scripts/deploy-remote-staging.mjs" \
  --config .coding-workflow/deploy.staging.json \
  --target TARGET \
  --ref REF_OR_SHA \
  --dry-run
```

Execute only when the product repo's target config and operator approval are explicit:

```bash
node "$CODING_WORKFLOW/scripts/deploy-remote-staging.mjs" \
  --config .coding-workflow/deploy.staging.json \
  --target TARGET \
  --ref REF_OR_SHA \
  --execute
```

## Invariants

- Staging deploy evidence is not production release evidence.
- Missing env means skipped/partial, never covered.
- Dirty worktree fails closed unless explicitly allowed.
- Do not print secrets, signed URLs, access tokens, or raw env files.
- Rollback is evidence and command generation unless the product repo explicitly implements automatic rollback.
- Report unavailable tools, missing config, and skipped coverage honestly instead of fabricating evidence.
