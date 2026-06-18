# CI/CD Deploy Adoption Prompt

Copy this prompt into an agent running inside the product repo after the PR-review workflow is already understood.

```text
Adopt the reusable CI/CD and staging-deploy workflow from `seaskyjj/coding-workflow` into THIS project.

First read from the tooling repo:
- WORKFLOW.md
- BOOTSTRAP.md
- CICD-DEPLOY-WORKFLOW-PROPOSAL.md
- templates/consumer-local-gates.json
- templates/consumer-deploy-staging.json
- templates/consumer-self-hosted-runner-plan.md

Then inspect THIS product repo and open one PR that adds only product-owned config/wrappers:

1. Add `.coding-workflow/local-gates.json` by tailoring `templates/consumer-local-gates.json`.
   - Use real commands that pass in this repo.
   - Missing env may produce skipped/partial local evidence, never a fake pass.
   - Do not claim hosted CI coverage unless the local step actually covers it.

2. Add `.coding-workflow/deploy.staging.json` by tailoring `templates/consumer-deploy-staging.json`.
   - Use real staging host alias, repo root, service ids, health URL, smoke command, and log paths.
   - Keep `productionRelease=false` by using the staging deploy tool only for staging.
   - Do not write secrets, signed URLs, or tokens into config.
   - Pick explicit `healthAttempts`, `healthIntervalSeconds`, and `logExcerptLines`.

3. Add package/script wrappers only if they are portable.
   - Prefer `CODING_WORKFLOW="${CODING_WORKFLOW:-$HOME/Programs/coding-workflow}"`.
   - Do not hardcode `/Users/.../coding-workflow`.

4. Validate locally:
   - run a local gate profile with `--allow-dirty` only if the PR intentionally includes uncommitted local evidence;
   - run deploy with `--dry-run` first;
   - run `service-manager-plan.mjs` against the deploy config.

5. Report human-only prerequisites:
   - confirm target host access;
   - confirm service manager persistence;
   - create GitHub runner tokens interactively only if a self-hosted runner plan is eligible;
   - keep production promotion as a separate explicit workflow.

Boundaries: do not vendor the scripts, do not auto-merge, do not auto-promote production, do not fabricate hosted CI status, and do not turn missing env into covered evidence.
```
