# CI/CD runtime seam audit handoff

Status: handoff proposal for `coding-workflow` follow-up work.

This document records lessons from the TrainOS ST-P25 rollout and turns them
into reusable `coding-workflow` work items. It is intentionally detailed so a
separate Codex agent can implement the changes without relying on chat memory.

## Background

`coding-workflow` already has reusable pieces for:

- local PR gates (`scripts/local-pr-gate.mjs`);
- GitHub check diagnostics (`scripts/ci-diagnose-pr.mjs`);
- self-hosted runner planning (`scripts/self-hosted-runner-plan.mjs`);
- service-manager plans (`scripts/service-manager-plan.mjs`);
- remote staging deploys (`scripts/deploy-remote-staging.mjs`);
- consumer templates under `templates/`;
- a thin Codex skill under `skills/coding-workflow-cicd-deploy/`.

TrainOS adopted these ideas in ST-P25. During the real WSL staging rollout, a
large number of problems surfaced only after the team ran the actual operator
workflow:

1. Runtime config existed, but not every adjacent entrypoint consumed it. Some
   paths still required manual `export` or separate env setup.
2. Deploy generated an audit trail inside the repo. The first deploy worked,
   then the second deploy failed the dirty-worktree check because that audit
   output was untracked.
3. Systemd unit generation existed, but the real service installation and
   service user environment exposed missing log directory permissions, env-file
   read permissions, stdout/stderr setup, Node/npm path differences, and the
   difference between "unit file generated" and "unit installed and active".
4. The PR had local build and unit tests, but the actual proof required a
   remote self-hosted runner job that deployed the exact head SHA, restarted the
   expected services, checked health, verified port ownership, and ran the
   product smoke.
5. Some failures were environment-specific, but others were pure workflow
   logic gaps. The common cause was that validation was done at component
   boundaries instead of from the user-facing command seam.

The reusable lesson is not TrainOS-specific. Any product repo using
`coding-workflow` for deployment/runtime changes needs a standard way to prove:

- the command a human or CI actually runs goes through the intended path;
- all adjacent consumers use the same source-of-truth config;
- generated evidence does not poison the next run;
- the service manager is not only configured but actually owns the running
  process;
- local fallback evidence is not confused with hosted CI passing;
- self-hosted runner jobs have explicit security and cleanup boundaries.

## Goal

Add a reusable "runtime seam audit" layer to `coding-workflow`.

This should remain mechanism, not product policy. The shared repo should
provide checklists, templates, optional scripts, evidence schemas, and adoption
guidance. Product repos still own concrete commands, env names, service names,
ports, smoke tests, runtime config formats, and release decisions.

## Non-goals

- Do not add production promotion.
- Do not auto-register GitHub self-hosted runners.
- Do not store GitHub runner registration tokens.
- Do not assume systemd is the only service manager.
- Do not hardcode TrainOS service names, ports, env names, camera smokes, or
  host aliases.
- Do not silently relax dirty-worktree failure. Any allowlist must be explicit,
  narrow, and visible in evidence.
- Do not describe local or staging evidence as hosted CI passing unless the
  product repo has explicitly proven equivalence.

## Vocabulary

### User command seam

The end-to-end path beginning at the command or GitHub job the operator actually
runs. Examples:

- `npm run ci:local-pr -- --profile standard-stack`;
- `npm run deploy:wsl-staging`;
- `gh run rerun ...` on a self-hosted staging job;
- a product repo's wrapper around `deploy-remote-staging.mjs`.

The seam includes all invoked wrappers, generated env, runtime config, service
manager actions, health checks, smokes, logs, audit files, and cleanup.

### Source-of-truth config

The one config source a workflow claims to use. If a product repo introduces
`runtime-config.json`, then local gates, deploys, service units, and smokes must
either consume that config directly or record why they intentionally do not.

### Adjacent consumer

Another entrypoint that touches the same concern. For runtime config, adjacent
consumers include local gate, deploy, service startup, smoke scripts, and
diagnostic scripts. For systemd, adjacent consumers include unit generation,
unit installation, service restart, status checks, log collection, and port
owner verification.

### Evidence

Machine-readable and human-readable output that records what was actually run:
head SHA, host, commands, skipped steps, env gaps, health results, service
status, smoke output, dirty state, and audit trail path.

## Required reusable additions

### 1. Runtime seam audit checklist

Add a checklist section to the docs and reviewer guidance for CI/CD, deploy,
runtime config, and service-manager changes.

The checklist should require implementers to answer:

1. What exact command or GitHub job will the user run?
2. What wrappers does that command call?
3. What config is the source of truth?
4. Which adjacent entrypoints still read env/config separately?
5. Does any old path bypass the new abstraction?
6. Does the command work from a clean checkout?
7. Does the command work when run twice in a row?
8. Does generated evidence remain outside tracked source, or is it ignored by
   a documented, narrow rule?
9. If the workflow starts services, does it verify the service manager owns the
   process and the expected port?
10. If a smoke is skipped, is the result `partial` or `skipped` rather than
    `passed`?
11. Are secrets, signed URLs, raw env files, and tokens kept out of logs and
    PR comments?
12. Is any fallback, retry, timeout, or cleanup behavior explicit and recorded?

Where to update:

- `WORKFLOW.md`, under "Local CI and staging deploy evidence";
- `CICD-DEPLOY-WORKFLOW-PROPOSAL.md`, as a follow-up implemented design item;
- `templates/consumer-cicd-adoption-prompt.md`, so product-repo agents run the
  seam audit while adopting;
- `skills/coding-workflow-cicd-deploy/SKILL.md`, so Codex uses the checklist
  before saying a deployment/runtime task is done;
- optionally `reviewer/CHECKLIST.md`, if code review should flag missing seam
  evidence.

Acceptance:

- A product repo agent can read the checklist and know what must be verified
  before marking a CI/CD/runtime change complete.
- The docs explicitly say component tests are insufficient for command-seam
  completion.

### 2. Deploy-twice validation mode

The TrainOS audit-trail issue only appeared on the second deploy. Add reusable
guidance and, if practical, a helper mode for repeated deployment validation.

Desired behavior:

- run deploy once against a target/ref;
- run it a second time without manual cleanup;
- verify the second run does not fail because of the first run's own evidence;
- verify the remote worktree dirty policy remains fail-closed for unrelated
  dirty state;
- record both run ids and evidence paths.

Implementation options:

Option A, docs-only first:

- update `CICD-DEPLOY-WORKFLOW-PROPOSAL.md` and the skill to say deploy
  adoption is not complete until a repeat run has been tested.

Option B, script support:

- add `--repeat N` or `--verify-repeat` to `deploy-remote-staging.mjs`;
- or add a new wrapper script such as `scripts/deploy-repeat-check.mjs` that
  calls the existing deploy script twice and summarizes evidence.

Design requirements:

- The repeated run must not silently pass if the first run failed.
- The repeated run must not set broad `--allow-dirty` by default.
- If a product repo needs an evidence allowlist, it must be explicit in product
  config, not hidden in shared code.
- The summary must distinguish "first deploy passed, second deploy failed"
  from "both passed".

Acceptance:

- There is a documented way for a product repo to prove deploy idempotence.
- A test or self-test covers the case where generated evidence would otherwise
  make the next dirty check fail.

### 3. Runtime config source-of-truth contract

The TrainOS standard-stack gap was that runtime config existed, but the local
PR gate still required manual env export. Make this a reusable contract.

Add documentation and optional template fields for:

- `runtimeConfigPath`;
- `runtimeConfigEnvCommand`;
- `runtimeConfigEnvMapper`;
- per-step `usesRuntimeConfig: true`;
- explicit statement when a step intentionally does not use runtime config.

Example product-owned local gate shape:

```json
{
  "schemaVersion": 1,
  "runtimeConfig": {
    "path": "config/runtime.local.json",
    "envCommand": "node scripts/runtime-config-env.mjs config/runtime.local.json"
  },
  "profiles": {
    "standard-stack": {
      "steps": [
        {
          "id": "standard-stack-smoke",
          "command": "npm run smoke:standard-stack",
          "required": true,
          "usesRuntimeConfig": true,
          "covers": ["database", "object_storage", "api_health"]
        }
      ]
    }
  }
}
```

The exact config format can differ, but the evidence should say:

- runtime config path used;
- env keys produced, with values redacted;
- steps that consumed it;
- steps skipped because required runtime config was missing;
- steps that still required manual env and why.

Acceptance:

- Local gates can be configured so standard-stack smoke does not need a manual
  pre-run `eval "$(node ...)"`.
- Missing runtime config yields `partial` or `failed` evidence, not a false
  pass.
- The docs warn that a runtime config is not implemented until all adjacent
  command paths consume it or record an exception.

### 4. Service-manager preflight and ownership checks

The TrainOS rollout exposed several systemd-specific gaps. Generalize them into
service-manager preflight.

For systemd targets, preflight should be able to check or document:

- unit exists;
- unit is enabled when expected;
- `ExecStart` points to the intended command or built artifact;
- `WorkingDirectory` exists;
- env file exists;
- service user can read the env file, or the unit intentionally runs as a user
  that can;
- stdout/stderr targets are valid;
- log directory exists and is writable by the service user;
- expected Node/npm/binary paths exist for the service user;
- service is active after restart;
- expected port is owned by a process in the expected service cgroup.

For non-systemd managers, define equivalent categories:

- process supervisor config exists;
- command path;
- env source;
- log path;
- restart/status commands;
- port/process ownership proof.

Implementation options:

- Extend `scripts/service-manager-plan.mjs` to output preflight commands in
  addition to status/restart commands.
- Add a template such as `templates/consumer-service-manager-preflight.json`.
- Add evidence fields to deploy output:
  - `serviceManagerPreflight.status`;
  - `serviceManagerPreflight.checks[]`;
  - `portOwnership.status`;
  - `portOwnership.detail`.

Important caveat:

- Some ownership checks require privileges. For example, `ss -ltnp` may omit
  `pid=` for non-privileged users. The check must fail closed or mark
  `needs_privilege` honestly, not pretend the port is verified.

Acceptance:

- Product docs can tell an operator exactly what systemd preflight checks are
  required before relying on deploy automation.
- Deploy evidence can show whether service ownership was verified, skipped, or
  not inspectable.

### 5. Generated evidence hygiene

Generated CI/CD and deploy evidence should not cause source-tree drift.

Add guidance and optional config for:

- local evidence output root, defaulting to an ignored temp path;
- remote deploy audit trail path;
- whether audit trail is inside or outside the repo;
- explicit ignored paths for generated evidence;
- dirty-check allowlist limited to generated evidence paths;
- proof that unrelated dirty files still fail closed.

Recommended policy:

- Prefer evidence under `tmp/`, `.coding-workflow/`, `.trainos/`, or another
  product-owned ignored path.
- If evidence lives under the repo root, the product repo must add a matching
  `.gitignore` rule.
- Shared tooling should not ignore arbitrary untracked files.
- Any dirty-check filter must be narrow and visible in logs.

Acceptance:

- Consumer templates include an ignored audit/evidence path.
- Self-tests cover generated evidence that should be ignored and unrelated
  dirty files that must still fail.

### 6. Self-hosted runner operations checklist

The current self-hosted runner plan is evidence-only. Add a separate operations
checklist for when the human actually installs a runner.

Document:

- choose repo-level runner first for a single product repo;
- do not put the runner directory inside the project working tree;
- use a dedicated OS user if possible;
- use stable labels such as `product-staging`, not generic `self-hosted` only;
- do not run untrusted fork PRs on the runner;
- install as a service after manual verification;
- configure cleanup of workspace, temp files, background processes, and
  generated evidence;
- record installed runner name, labels, host, service status, and scope;
- keep GitHub registration token out of repo, logs, PR comments, and evidence
  files;
- ensure required runtime dependencies are present: language runtime, package
  manager, browser deps, DB/object-store access, ffmpeg or other product tools;
- verify a minimal job can run before routing important gates.

Acceptance:

- `templates/consumer-self-hosted-runner-plan.md` clearly separates "plan
  generation" from "manual runner installation and service setup".
- The skill does not imply `self-hosted-runner-plan.mjs` installs anything.

### 7. CI diagnostics for queued and fast-fail jobs

Add guidance to diagnose:

- queued jobs: missing runner, wrong labels, offline runner, runner group not
  available to repo, concurrency saturation;
- fast-fail jobs: workflow syntax, checkout failure, missing action, missing
  secret, setup failure before logs, dependency resolution failure;
- real product failures: tests run and fail with product error output.

`ci-diagnose-pr.mjs` should keep these classes separate.

Acceptance:

- Diagnostics do not collapse all failures into hosted-runner unavailability.
- Diagnostics tell the operator what evidence is missing before recommending a
  self-hosted runner.

### 8. Cleanup workflow template

The TrainOS rollout left many temp files on local and remote hosts. Add a
generic cleanup workflow template for test, deploy, and staging artifacts.

Requirements:

- dry-run by default;
- explicit roots to inspect;
- product-owned keep rules;
- product-owned delete rules;
- never delete outside configured roots;
- classify files as generated evidence, logs, build output, cache, downloaded
  artifacts, user-provided artifacts, or unknown;
- unknown files are not deleted by default;
- output `cleanup-plan.json` and `cleanup-plan.md`;
- execute only with explicit `--execute`;
- record deleted paths and skipped paths;
- support remote cleanup through the existing deploy SSH target mechanism only
  when the product config declares it.

This can be a future script such as `scripts/temp-cleanup-plan.mjs`.

Acceptance:

- Product repos can adopt a cleanup plan without writing ad hoc `rm -rf`
  commands.
- The cleanup plan is evidence and operator-controlled, not automatic deletion.

## Suggested implementation plan

Implement in small PRs.

### PR 1: docs and skill seam-audit checklist

Files likely touched:

- `WORKFLOW.md`;
- `CICD-DEPLOY-WORKFLOW-PROPOSAL.md`;
- `BOOTSTRAP.md`;
- `templates/consumer-cicd-adoption-prompt.md`;
- `skills/coding-workflow-cicd-deploy/SKILL.md`;
- optionally `reviewer/CHECKLIST.md`.

Deliverable:

- documented runtime seam audit checklist;
- documented deploy-twice requirement;
- documented runtime config source-of-truth rule;
- documented service-manager preflight categories.

Validation:

- `git diff --check`;
- any existing docs/check scripts if present;
- local AI proposal review if this repo's process requires it.

### PR 2: template expansion

Files likely touched:

- `templates/consumer-local-gates.json`;
- `templates/consumer-deploy-staging.json`;
- `templates/consumer-self-hosted-runner-plan.md`;
- possibly new template for service-manager preflight;
- possibly new template for cleanup plan.

Deliverable:

- consumer templates include runtime config fields, evidence paths, service
  preflight notes, and self-hosted runner operation notes.

Validation:

- JSON parse checks;
- `node scripts/cicd-self-test.mjs` if templates are part of that self-test;
- `git diff --check`.

### PR 3: script support for seam evidence

Possible script changes:

- `local-pr-gate.mjs`: accept runtime config metadata or env command, record
  runtime config evidence, and fail honestly on missing config.
- `deploy-remote-staging.mjs`: support repeat validation or a narrow generated
  evidence dirty allowlist declared by product config.
- `service-manager-plan.mjs`: emit preflight commands and evidence schema.
- `ci-diagnose-pr.mjs`: improve queued vs fast-fail classification.
- new `temp-cleanup-plan.mjs`: dry-run cleanup evidence only.

Validation:

- `node scripts/cicd-self-test.mjs`;
- targeted tests for each changed script;
- `git diff --check`;
- run an example dry-run against template config.

### PR 4: adoption prompt and README refresh

Files likely touched:

- `README.md`;
- `ADOPT-PROMPT.md`;
- `BOOTSTRAP.md`;
- skill docs.

Deliverable:

- an external product agent can adopt the CI/CD workflow without prior TrainOS
  context.

Validation:

- read-through from a blank product repo perspective;
- proposal review if available.

## Review expectations

For these follow-up PRs, reviewers should check:

- no TrainOS-specific values are hardcoded into shared scripts;
- defaults do not silently change product behavior;
- skipped or partial evidence cannot be reported as passed;
- dirty-worktree allowlists are explicit and narrow;
- generated evidence paths are documented and safe;
- service-manager checks honestly report missing privileges;
- self-hosted runner docs do not encourage unsafe fork PR execution;
- scripts keep production promotion out of staging deploy.

## Concrete TrainOS symptoms mapped to reusable checks

| TrainOS symptom | Reusable check |
| --- | --- |
| Runtime config existed but local gate still needed manual env export | Runtime config source-of-truth contract across adjacent consumers |
| Deploy audit trail made second deploy dirty | Deploy-twice validation and generated evidence hygiene |
| Generated systemd unit was not the same as installed service | Service-manager preflight and ownership evidence |
| Unit failed with stdout/log/env permissions | Systemd preflight for env file, log dir, stdout/stderr |
| Smoke only worked after remote WSL dependencies were aligned | Self-hosted runner operations checklist and dependency evidence |
| Hosted jobs fast-failed while self-hosted deploy passed | CI diagnostics must separate hosted fast-fail from staging evidence |
| Agent initially treated local script tests as sufficient | Runtime seam audit required before claiming implementation |

## Success criteria for the whole follow-up

The work is complete when a product repo agent can follow the updated
`coding-workflow` docs and answer, with generated or documented evidence:

1. Which command was run?
2. Which ref/head SHA was tested?
3. Which runtime config was used?
4. Which adjacent consumers were checked?
5. Whether a second run was tested?
6. Whether generated evidence is ignored or stored safely?
7. Which service manager owns the running process?
8. Which health and smoke checks passed?
9. Which checks were skipped or partial?
10. Which remaining steps are human/operator-owned?

If any of these answers are missing, the product repo should mark the CI/CD or
runtime change as `partial`, not `implemented`.
