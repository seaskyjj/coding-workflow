# CI/CD and deploy workflow proposal

Status: implemented design record; reusable-shape validation still pending.

This document describes how `coding-workflow` extends from PR review tooling into a reusable CI/CD and staging-deploy workflow. It remains the design record; current behavior is defined by the referenced scripts, templates, tests, and skill template. The extraction is implemented, but cross-product reuse is still a hypothesis until TrainOS adopts this repo as an external consumer, or a second product repo adopts it without shared-script/template changes.

## Why this belongs in `coding-workflow`

The extraction is based on one concrete product experience, TrainOS. The hypothesis is that other product repos with the same operating loop can reuse the mechanism:

1. GitHub hosted Actions sometimes fail or are unavailable.
2. A local or self-hosted non-AI gate is still needed to keep PRs moving.
3. Remote staging environments need a repeatable deploy command instead of hand-written SSH / `nohup` / ad hoc process cleanup.
4. The deploy output must be auditable: commit deployed, service status, health result, smoke result, log locations, rollback ref, and clear production vs staging boundary.
5. Agents need one standard skill/instruction path to run this without inventing commands per repo.

TrainOS has proven these needs for one concrete product. The reusable parts moved here as mechanism; TrainOS-specific commands, services, ports, and success markers remain product adapter configuration. This document does not claim that multi-product reuse is proven yet.

Validation still required before calling the abstraction stable:

- adopt this tooling back into TrainOS as an external consumer that references `coding-workflow` instead of vendoring it;
- or adopt it into a second product repo with only `.coding-workflow/*.json` config and wrappers;
- record any required shared-script/template changes as evidence that the mechanism/policy split was incomplete.

## Core principle

`coding-workflow` should provide mechanism, not product policy.

Shared tooling can define:

- local gate runner structure;
- CI check diagnostics and fallback evidence format;
- remote deploy plan / script generation;
- service manager abstraction;
- rollback evidence and audit trail format;
- self-hosted runner decision checklist;
- adoption templates and skill instructions.

Product repos must define:

- commands to run;
- service names;
- env requirements;
- health URLs and success markers;
- smoke tests;
- deployment target names;
- production promotion rules;
- repo-specific overlays and decisions.

No reusable template should silently inject product-visible limits, hidden timeouts, automatic fallback behavior, or production release decisions. If a default exists, it must be documented as either test-only, operator-configured, or a template placeholder that a product repo must confirm.

## Relationship to existing PR review workflow

Existing `coding-workflow` already has:

- `WORKFLOW.md` for process principles;
- `BOOTSTRAP.md` and `ADOPT-PROMPT.md` for adoption;
- `scripts/ai-review.mjs` for local / CLI / API review;
- `templates/consumer-ci.yml` and `templates/consumer-ai-review.yml`;
- a thin `coding-workflow-pr-review` skill outside this repo.

The CI/CD extension should follow the same pattern:

- scripts live in this repo;
- product repos reference this repo instead of vendoring logic;
- consumer templates are small and project-tailored;
- the skill is thin and delegates to this repo's docs/scripts;
- source of truth remains GitHub plus generated evidence, not manually maintained chat state.

## Proposed user-facing concepts

### 1. Local PR gate

A local PR gate is a declared set of commands that can run on an operator machine or self-hosted runner and produce structured evidence.

It is not the same as GitHub hosted CI unless the evidence says so.

Inputs:

- repo root;
- PR number or explicit base/head refs;
- gate profile id;
- output directory;
- optional `--allow-dirty` for intentionally collecting dirty-tree evidence;
- optional product config file;
- optional hosted gate names from workflow parsing.

Outputs:

- `local-pr-gate.json`;
- `local-pr-gate.md`;
- per-step logs;
- clean / dirty worktree evidence;
- `headSha`;
- host and platform;
- per-step status: `passed`, `failed`, `skipped`;
- missing env reason when a step is skipped;
- coverage matrix against hosted checks.

Required properties:

- A required failed step fails the local gate.
- A required missing-env skip yields `partial` evidence and a non-zero local gate exit; local gates do not currently define any other skip path.
- Missing env skip must downgrade coverage. It must not claim partial Postgres/S3/browser coverage if the relevant step did not run.
- Dirty worktree fails closed unless `--allow-dirty` is explicitly provided.
- Output uses best-effort denylist redaction for known token, URL-query, authorization-header, and secret-assignment patterns. It must not intentionally print raw env files or signed URLs, but regex redaction is not a complete guarantee for unknown secret shapes.
- Local gate status should be honest: usually `failed` or `partial`, not "passed hosted CI".

Suggested CLI:

```bash
node "$CODING_WORKFLOW/scripts/local-pr-gate.mjs" \
  --profile p0-node \
  --config .coding-workflow/local-gates.json \
  --output-dir tmp/local-pr-gate/pr-123 \
  --json
```

Suggested product `package.json` wrapper:

```json
{
  "scripts": {
    "ci:local-pr": "node $CODING_WORKFLOW/scripts/local-pr-gate.mjs --config .coding-workflow/local-gates.json"
  }
}
```

The exact wrapper may need a portable helper because npm scripts do not always expand `$CODING_WORKFLOW` consistently across shells. The implementation should decide this explicitly.

### 2. Gate profiles

A gate profile is a named command set. Profiles should be declarative and product-owned.

Example product config:

```json
{
  "schemaVersion": 1,
  "profiles": {
    "docs": {
      "description": "Documentation and workflow-policy check only.",
      "steps": [
        {
          "id": "agent-instructions",
          "command": "npm run agent-instructions:check",
          "required": true,
          "covers": ["repo_policy"]
        },
        {
          "id": "diff-check",
          "command": "git diff --check",
          "required": true,
          "covers": ["diff_integrity"]
        }
      ],
      "hostedCoverage": {
        "gate": {
          "status": "partial",
          "note": "Docs profile does not run product tests."
        },
        "postgres-integration": {
          "status": "skipped",
          "note": "Docs profile does not reproduce DB integration jobs."
        }
      }
    },
    "standard-stack": {
      "description": "Local standard-stack smoke with product services.",
      "steps": [
        {
          "id": "standard-stack-smoke",
          "command": "npm run p0:smoke:standard-stack",
          "required": true,
          "covers": [
            "postgres",
            "object_storage",
            "api_health",
            "worker_smoke"
          ],
          "skipIfMissingEnv": [
            "P0_DATABASE_URL",
            "P0_OBJECT_STORAGE_DRIVER",
            "P0_S3_ENDPOINT",
            "P0_S3_BUCKET",
            "P0_S3_ACCESS_KEY_ID",
            "P0_S3_SECRET_ACCESS_KEY"
          ]
        }
      ],
      "hostedCoverage": {
        "postgres-integration": {
          "statusWhenAllCoveredStepsPassed": "partial",
          "statusWhenCoveredStepSkipped": "skipped",
          "note": "Product-specific local smoke is not the exact hosted service-container job."
        }
      }
    }
  }
}
```

Open question for implementation: whether profile config should be JSON only, YAML only, or both. JSON is simpler to parse without adding dependencies. YAML is friendlier for humans but adds dependency and schema validation work.

### 3. GitHub check diagnostics

Before recommending local fallback, tooling should classify PR checks and workflow runs.

Classifications:

- `passing`;
- `pending`;
- `hosted_runner_unavailable`;
- `workflow_configuration`;
- `metered_api_review_skip`;
- `test_failure`;
- `quota_or_billing`;
- `transient_or_cancelled`;
- `unknown_failure`.

Required behavior:

- Do not classify a real test failure as hosted runner unavailability just because another job in the same workflow lacked a runner.
- Do not treat intentional API AI review skip as a product test failure.
- Do not treat workflow syntax/config failure as hosted runner unavailability.
- Redact failed-run logs before writing PR comments.
- Use bounded run history and bounded failed log excerpts.
- Output a recommendation that separates:
  - fix workflow;
  - fix product tests;
  - wait for pending checks;
  - local fallback may be useful;
  - self-hosted runner may be warranted.

Suggested CLI:

```bash
node "$CODING_WORKFLOW/scripts/ci-diagnose-pr.mjs" \
  --repo OWNER/REPO \
  --pr 123 \
  --history-limit 20 \
  --post-comment
```

Outputs:

- JSON diagnostics;
- Markdown summary;
- optional PR comment;
- redacted evidence snippets;
- recommendation.

### 4. Self-hosted runner plan

Self-hosted runner setup should not be the first response to one broken PR. Tooling should generate a plan only when evidence shows a real hosted-runner availability gap and local gates are insufficient.

Required inputs:

- repeated hosted runner unavailability evidence;
- local gate evidence with machine-checkable coverage gaps;
- operator note explaining the local-gate insufficiency context;
- target host / runner labels / repo scope;
- secret handling plan;
- cleanup plan.

Output should be a plan, not automatic registration.

Suggested CLI:

```bash
node "$CODING_WORKFLOW/scripts/self-hosted-runner-plan.mjs" \
  --diagnostics-json tmp/ci-diagnostics/pr-123.json \
  --local-gate-json tmp/local-pr-gate/pr-123/local-pr-gate.json \
  --local-ci-insufficient-note "Branch protection needs visible PR checks."
```

Acceptance:

- Without both repeated hosted-runner evidence and machine-checkable local-CI insufficiency from `local-gate-json`, status is `not_eligible`.
- The operator note is required context, but it is not sufficient by itself to make a plan eligible.
- The script never writes GitHub runner tokens to disk.
- The script does not register a runner.
- It produces human-reviewable commands and prerequisites only.

### 5. Remote staging deploy

Remote deploy tooling should replace ad hoc SSH sessions with a generated, auditable staging deploy script.

It must not be a production release platform by default.

Inputs:

- target host alias;
- repo root on remote;
- ref or SHA to deploy;
- dependency install mode;
- service manager type;
- service ids;
- build command;
- optional migration command;
- health URL;
- optional smoke command;
- log paths;
- optional rollback ref;
- dirty-worktree policy.

Outputs:

- generated remote script;
- redacted summary;
- SSH argv;
- audit trail path;
- rollback command template;
- service manager plan.

Required behavior:

- Fetch and checkout the requested ref.
- Prefer exact commit SHA support.
- Fail closed if remote worktree is dirty unless `--allow-dirty` is explicit.
- Print before/after service status.
- Run build.
- Run explicitly provided migration command only when operator supplies one.
- Restart through a standard service manager command, not ad hoc `nohup`.
- Run health and smoke.
- Print deployed commit and rollback ref.
- Append JSONL audit record.
- Redact health URL query strings and known token/secret patterns on generated evidence; do not place signed URLs or raw secrets in config.
- Mark `productionRelease=false` unless a separate production workflow is explicitly implemented.

Suggested CLI:

```bash
node "$CODING_WORKFLOW/scripts/deploy-remote-staging.mjs" \
  --config .coding-workflow/deploy.staging.json \
  --target win10-wsl \
  --ref feature/my-branch \
  --npm-ci \
  --dry-run
```

Product wrapper example:

```json
{
  "scripts": {
    "deploy:wsl-staging": "node $CODING_WORKFLOW/scripts/deploy-remote-staging.mjs --config .coding-workflow/deploy.wsl-staging.json"
  }
}
```

Example product deploy config:

```json
{
  "schemaVersion": 1,
  "targets": {
    "win10-wsl": {
      "host": "win10-wsl",
      "repoRoot": "/home/app/TrainOS",
      "manager": "systemd",
      "services": ["api", "analysis-worker", "scan-worker"],
      "apiPort": 4173,
      "buildCommand": "npm run p0-node:build",
      "healthUrl": "http://127.0.0.1:4173/p0/health",
      "healthAttempts": 30,
      "healthIntervalSeconds": 2,
      "sshBatchMode": true,
      "sshConnectTimeoutSeconds": 10,
      "executionTimeoutSeconds": 900,
      "smokeCommand": "npm run p0:smoke:standard-stack",
      "auditTrailPath": ".coding-workflow/deploy/history.jsonl",
      "logExcerptLines": 120,
      "logPaths": [
        "/var/log/trainos-p0/api.log",
        "/var/log/trainos-p0/api.err.log"
      ]
    }
  }
}
```

The values above are examples only. Product repos must own real target names, service ids, ports, health URLs, and smoke commands.

### 6. Service manager abstraction

The reusable layer should generate commands for a small set of service managers:

- `systemd`, preferred for unattended Linux staging;
- `pm2`, operator-attended unless boot persistence is verified;
- `docker-compose`, optional later;
- `none`, only for dry-run or documentation mode.

Service manager output should include:

- `status` command;
- `restart` command;
- `stop` command;
- recent logs command;
- health check command or notes;
- warnings and notes.

Required boundaries:

- Do not silently choose `pm2` as production-equivalent.
- Do not claim restart persistence unless systemd or pm2 startup persistence is verified.
- Keep command generation separate from execution so it can be tested without touching the host.

### 7. Rollback evidence

The shared deploy tool should not automatically roll back on failure unless a product explicitly designs and accepts that behavior.

It should produce enough evidence for a human/operator to perform rollback:

- `beforeHead`;
- `deployedHead`;
- `rollbackRef`;
- rollback command template;
- audit trail line;
- status and log excerpts after deploy;
- health/smoke result.

Audit JSONL record should include:

```json
{
  "completedAt": "2026-06-18T00:00:00Z",
  "deploymentKind": "scripted_staging",
  "productionRelease": false,
  "requestedRef": "feature/my-branch",
  "beforeHead": "oldsha",
  "deployedHead": "newsha",
  "rollbackRef": "oldsha",
  "healthUrl": "<redacted-health-url>",
  "smoke": "provided"
}
```

Implementation detail: do not assemble JSON with raw shell `printf`. Use JSON serialization or validate/escape all fields. Operator-supplied refs may contain characters that break JSON.

### 8. Product adapter files

Recommended product repo layout:

```text
.coding-workflow/
  local-gates.json
  deploy.wsl-staging.json
  deploy.staging.json
  self-hosted-runner.md
reviewer-overlay.md
.github/workflows/
  ci.yml
  ai-review.yml
```

`coding-workflow` should provide templates for these files:

```text
templates/consumer-local-gates.json
templates/consumer-deploy-staging.json
templates/consumer-service-manager-systemd.json
templates/consumer-self-hosted-runner-plan.md
templates/consumer-cicd-adoption-prompt.md
```

Product repos should tailor them in one adoption PR.

## Proposed skill

Add a new thin skill outside or alongside the existing review skill:

Name:

```text
coding-workflow-cicd-deploy
```

Purpose:

- operate the reusable CI/CD and staging-deploy workflow in a product repo;
- generate or inspect local gate evidence;
- diagnose GitHub check failures;
- create self-hosted runner plans;
- generate and run remote staging deploy scripts;
- verify rollback/audit evidence.

The skill should not contain core implementation logic. It should:

1. locate `coding-workflow` through `CODING_WORKFLOW` or `$HOME/Programs/coding-workflow`;
2. read the current repo docs;
3. read product `.coding-workflow/*.json` config;
4. run the scripts from the tooling checkout;
5. report honest evidence and gaps;
6. never auto-merge, auto-promote production, or write secrets.

Suggested `SKILL.md` shape:

```markdown
---
name: coding-workflow-cicd-deploy
description: Operate reusable local CI gates, GitHub check diagnostics, self-hosted runner planning, and remote staging deploys through the coding-workflow repository.
---

# Coding Workflow CI/CD Deploy

Use this as a thin operator layer over the `coding-workflow` repository.
Do not copy or vendor scripts into the product repo.

## Locate tooling

Set `CODING_WORKFLOW="${CODING_WORKFLOW:-$HOME/Programs/coding-workflow}"`.
If current repo is `coding-workflow`, use it directly.

Before acting, read:
- WORKFLOW.md
- BOOTSTRAP.md
- CICD-DEPLOY-WORKFLOW.md
- templates/consumer-local-gates.json
- templates/consumer-deploy-staging.json

## Run local PR gate

...

## Diagnose GitHub checks

...

## Deploy staging

...

## Invariants

- Staging deploy evidence is not production release evidence.
- Missing env means skipped/partial, never covered.
- Dirty worktree fails closed unless explicitly allowed.
- Do not intentionally print secrets, signed URLs, access tokens, or raw env files; treat built-in redaction as best-effort denylist coverage, not a guarantee.
- Rollback is evidence and command generation unless the product repo explicitly implements automatic rollback.
```

## Existing docs to update when implemented

### `README.md`

Add rows for:

- `scripts/local-pr-gate.mjs`;
- `scripts/ci-diagnose-pr.mjs`;
- `scripts/deploy-remote-staging.mjs`;
- `scripts/service-manager-plan.mjs`;
- `scripts/self-hosted-runner-plan.mjs`;
- new templates;
- CI/CD skill.

Clarify that PR review and CI/CD deploy are separate tool families under the same workflow principles.

### `WORKFLOW.md`

Add a small section after the non-AI gate:

- local CI fallback is evidence, not a hosted CI replacement unless explicitly equivalent;
- remote staging deploy is scripted evidence, not production release;
- self-hosted runner setup requires evidence, not impulse;
- every fallback decision must be recorded in GitHub or generated artifacts.

Keep this short. Detailed mechanics should stay in the new CI/CD doc.

### `BOOTSTRAP.md`

Add adoption steps:

1. copy / tailor local gate config;
2. copy / tailor deploy staging config;
3. set product wrappers;
4. run dry-run local gate;
5. run dry-run deploy plan;
6. state human-only prerequisites.

### `ADOPT-PROMPT.md`

Add optional CI/CD adoption section:

- only add product config and wrappers;
- do not vendor scripts;
- do not write secrets;
- keep production release out of scope unless explicitly requested;
- run local validation.

### `templates/consumer-ci.yml`

Do not make it product-heavy. Keep it as the GitHub hosted non-AI baseline. Add comments pointing to local fallback config for cases where hosted checks are unavailable.

## Implementation phases

### Phase 1 - proposal docs and templates

Goal: land design and adoption artifacts only.

Files:

- `CICD-DEPLOY-WORKFLOW-PROPOSAL.md` or rename to `CICD-DEPLOY-WORKFLOW.md` after accepted;
- `templates/consumer-local-gates.json`;
- `templates/consumer-deploy-staging.json`;
- `templates/consumer-self-hosted-runner-plan.md`;
- README links.

Validation:

- markdown links sanity;
- proposal review with `REVIEW_KIND=proposal`;
- no code behavior claimed as implemented.

### Phase 2 - local gate core

Goal: reusable local gate runner.

Files:

- `scripts/local-pr-gate.mjs`;
- `scripts/local-pr-gate.test.mjs`;
- JSON schema for config and output;
- README / BOOTSTRAP update.

Acceptance:

- clean worktree required by default;
- missing env skipped/partial behavior;
- required skipped without missing env fails;
- hosted coverage derived from actual step results;
- redacted Markdown output;
- no product hardcoding.

### Phase 3 - check diagnostics

Goal: classify GitHub check failures before recommending local fallback.

Files:

- `scripts/ci-diagnose-pr.mjs`;
- tests with fixture JSON;
- redaction helpers.

Acceptance:

- runner outage vs test failure vs workflow config failure classified separately;
- failed logs redacted;
- PR comment optional;
- local fallback not recommended for real tests/workflow failures.

### Phase 4 - service manager and deploy plan

Goal: generate staging deploy scripts without running them by default.

Files:

- `scripts/service-manager-plan.mjs`;
- `scripts/deploy-remote-staging.mjs`;
- tests for generated scripts.

Acceptance:

- systemd and pm2 supported with correct warnings;
- dirty remote worktree fail-closed;
- exact ref checkout;
- pre/post service status;
- health/smoke;
- rollback command template;
- JSONL audit generated through safe JSON serialization;
- `productionRelease=false` explicit.

### Phase 5 - self-hosted runner plan

Goal: evidence-gated plan for self-hosted runners.

Files:

- `scripts/self-hosted-runner-plan.mjs`;
- template runbook.

Acceptance:

- not eligible without repeated hosted runner evidence;
- not eligible without machine-checkable local coverage gaps plus a local CI insufficiency note;
- no runner token handling;
- no automatic registration.

### Phase 6 - skill wrapper

Goal: thin operator skill.

Files outside repo or in a documented install location:

- `skills/coding-workflow-cicd-deploy/SKILL.md`;
- optional helper validation script.

Acceptance:

- skill reads repo docs before acting;
- skill calls scripts, not reimplemented shell;
- skill reports unavailable tools instead of fabricating evidence.

## Suggested agent task prompt for implementation

Use this prompt in the `coding-workflow` repo:

```text
Implement the CI/CD and deploy workflow extension described in `CICD-DEPLOY-WORKFLOW-PROPOSAL.md`.

Do it as small PRs:
1. docs/templates only;
2. local gate runner;
3. GitHub check diagnostics;
4. service manager + remote staging deploy plan;
5. self-hosted runner plan;
6. thin skill wrapper docs.

Do not copy TrainOS-specific commands into shared defaults. Use TrainOS only as an example in tests or fixtures when clearly labeled. Keep product-specific service names, ports, env names, and smoke markers in product config examples.

Every behavior must have tests. Do not claim implemented in README until scripts exist. Use proposal review for docs-only PRs and code review for script PRs.
```

## Risks and guardrails

### Risk: product-specific behavior leaks into shared templates

Guardrail:

- shared templates should use placeholder commands or clearly labeled examples;
- tests should verify no TrainOS-specific service names are hardcoded in core scripts.

### Risk: local gate evidence is mistaken for hosted CI passing

Guardrail:

- local gate output has coverage matrix;
- `partial` and `skipped` are first-class;
- PR comments say "local evidence" and list hosted gates not reproduced.

### Risk: staging deploy becomes accidental production release

Guardrail:

- generated deploy records include `productionRelease=false`;
- production release requires a separate explicit workflow and human approval;
- skill refuses to describe staging deploy as production.

### Risk: secrets leak through logs or comments

Guardrail:

- redact known token, URL query, authorization header, and secret-like env patterns;
- document that redaction is denylist/best-effort and not a guarantee for unknown secret shapes;
- do not echo env files;
- tests with secret-like fixtures;
- keep full logs local unless redacted before PR comments.

### Risk: automatic rollback hides root cause

Guardrail:

- default is rollback evidence and rollback command template only;
- automatic rollback must be a separate product decision.

### Risk: self-hosted runner overreaction

Guardrail:

- require repeated hosted-runner evidence and local-CI insufficiency;
- produce plan only;
- registration remains a human-controlled step.

## Implementation choices recorded

1. Config format: JSON only for implemented templates and parsers.
2. Script language: plain Node `.mjs` with no new runtime dependencies.
3. Skill location: repo-local template at `skills/coding-workflow-cicd-deploy/SKILL.md`; operators may install or copy it into their Codex skills directory.
4. Local gate PR comments: not implemented in `local-pr-gate.mjs`; CI diagnostics owns optional PR comment upsert with its own marker.
5. Deploy scripts: `deploy-remote-staging.mjs` always generates a script and supports explicit `--execute`; examples use `--dry-run`.
6. `consumer-ci.yml`: fallback note only. Self-hosted runner jobs remain product-owned and evidence-gated.
7. Product repo pinning: adoption docs recommend commit SHA or tag, not floating `master`.

Implemented recommendation:

- Start JSON-only and dependency-free.
- Generate and execute SSH through the same CLI, but keep `--dry-run` mandatory in examples.
- Keep PR comment upsert scoped to CI diagnostics; do not couple AI review state with CI diagnostics state.
- Pin product adoption to a commit SHA or tag, not floating `master`.
