# Adoption prompt

Copy everything in the fenced block below into an agent (Claude Code / codex) running **inside the target product repo**. Replace `seaskyjj/coding-workflow` if your tooling repo lives elsewhere.

````
Adopt the reusable engineering workflow from the repo `seaskyjj/coding-workflow` into THIS project. Do not copy/vendor its scripts — reference it; only add small consumer config here.

FIRST, read these from coding-workflow (clone/fetch or read on GitHub): WORKFLOW.md, BOOTSTRAP.md, reviewer/CHECKLIST.md, reviewer/PROPOSAL-CHECKLIST.md, templates/consumer-ci.yml, templates/consumer-ai-review.yml. Follow WORKFLOW.md's principles (source-of-truth vs derived; PR sizing; finding→test; branch hygiene; asymmetric AI review; AI-review-yes/auto-merge-no; non-AI gate is the safety net).

THEN inspect THIS repo and do the following, opening ONE pull request (do not push to main directly):

1. .github/workflows/ci.yml — the non-AI gate. Start from templates/consumer-ci.yml and TAILOR to this repo's real toolchain/scripts:
   - detect the package manager and the actual build/test/typecheck/lint commands;
   - a fresh checkout has NO build output (dist) — if this is a cross-package monorepo, ensure dependent packages build in dependency order before typecheck/test (see the template's notes);
   - if any test shells out to system tools (e.g. ffmpeg), install them in the job (symptom: `spawn <tool> ENOENT`);
   - leave eval/visual/e2e gates commented unless they actually exist and can pass.

2. .github/workflows/ai-review.yml — copy templates/consumer-ai-review.yml; set `repository:` to the tooling repo; keep the graceful-degrade guards and concurrency as-is. The default Action intentionally skips metered API AI review; run local independent CLI review for deep/gate/confirm-fixes rounds (`codex-cli` when Claude implemented the PR, `claude-cli` when Codex implemented it).

3. reviewer-overlay.md at the repo ROOT — write PROJECT-SPECIFIC review rules for THIS codebase (do NOT copy another project's overlay). Derive them from this repo's real invariants: read its ADRs/requirements/docs and the code, and encode the bug classes that would actually hurt here (authz/tenant boundaries, user-visible vs internal data, fail-closed rules, contract/snapshot sync, provenance, dev-only-not-in-prod, visual/responsive). Keep it tight; each rule should be checkable with `file:line` + a test.

4. If this repo has an agent instruction file (for example AGENTS.md, CLAUDE.md, or similar), add a small "PR Review Workflow" section. It should tell future agents to run a local independent AI review after they create a PR, choosing a reviewer backend different from the implementer when possible. Default to `codex-cli` for PRs implemented by Claude, and use `claude-cli` for PRs implemented by Codex. Use a cwd-independent, configurable script path; do NOT hardcode `/Users/.../coding-workflow`:

   ```bash
   REPO_ROOT="$(git rev-parse --show-toplevel)"
   REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)"
   PR="$(gh pr view --json number --jq .number 2>/dev/null || true)"
   CODING_WORKFLOW="${CODING_WORKFLOW:-$HOME/Programs/coding-workflow}"
   AI_REVIEW_SCRIPT="$CODING_WORKFLOW/scripts/ai-review.mjs"
   REVIEW_BACKEND="${REVIEW_BACKEND:-codex-cli}"   # Claude implementer -> codex-cli; Codex implementer -> claude-cli.
   REVIEW_KIND="${REVIEW_KIND:-code}"              # Use proposal for ADRs/design docs/investigations.

   if [ ! -f "$AI_REVIEW_SCRIPT" ]; then
     echo "ai-review.mjs not found; skipping local AI review. CODING_WORKFLOW=$CODING_WORKFLOW"
   elif [ -z "$REPO" ]; then
     echo "No GitHub repo found for this checkout; skipping local AI review."
   elif [ -z "$PR" ]; then
     echo "No open PR found for the current branch; skipping local AI review."
   elif [ "$REVIEW_BACKEND" = "codex-cli" ] && ! { command -v codex >/dev/null && codex --version >/dev/null 2>&1; }; then
     echo "codex CLI unavailable; set REVIEW_BACKEND=claude-cli or run manual review."
   elif [ "$REVIEW_BACKEND" = "claude-cli" ] && ! { command -v claude >/dev/null && claude --version >/dev/null 2>&1; }; then
     echo "claude CLI unavailable; set REVIEW_BACKEND=codex-cli or run manual review."
   elif [ "$REVIEW_BACKEND" = "api" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
     echo "ANTHROPIC_API_KEY missing; set REVIEW_BACKEND=codex-cli/claude-cli or add the key only after explicit opt-in."
   else
     REVIEW_MODE="${REVIEW_MODE:-deep}" \
     REVIEW_PROFILE="${REVIEW_PROFILE:-standard}" \
     MAX_FINDINGS="${MAX_FINDINGS:-12}" \
     REVIEW_BACKEND="$REVIEW_BACKEND" \
     REVIEW_KIND="$REVIEW_KIND" \
     REVIEWER_OVERLAY="$REPO_ROOT/reviewer-overlay.md" \
     PR_LOG_PATH="${TMPDIR:-/tmp}/coding-workflow-pr-log.local.jsonl" \
     node "$AI_REVIEW_SCRIPT" --backend "$REVIEW_BACKEND" --review-kind "$REVIEW_KIND" --repo "$REPO" --pr "$PR"
   fi
   ```

   Keep the guardrails explicit: this command posts/updates a PR review comment only; it must not auto-merge or replace the non-AI CI gate. If the agent instruction file is covered by tests or linting, add a small check so the snippet does not regress to a machine-local absolute path and still passes `REVIEWER_OVERLAY`.

5. Open the PR following the conventions:
   - branch name uses a type prefix: feat/ fix/ refactor/ perf/ ci/ chore/ build/ docs/ test/ (with a task id if one exists, e.g. ci/setup-coding-workflow);
   - PR body includes: a task id (or note none), scope, out-of-scope, acceptance criteria (验收), verification commands (验证), known gaps;
   - keep it one coherent change.

6. Verify and report:
   - the ci gate must pass on the PR (fix real failures it surfaces — that's the point; turn any fix into a test where applicable);
   - the ai-review job should run its no-key checks and skip API AI review gracefully (green).
   - if the local reviewer CLI selected in step 4 is available and logged in, run the local review command once after opening the PR; if it is unavailable, report that explicitly instead of fabricating review status.
   - for ADRs, design docs, investigations, and next-step direction docs, run a proposal review once with `REVIEW_KIND=proposal`; for mixed code+proposal PRs, run both review kinds.

OPTIONAL CI/CD + staging-deploy adoption, only if explicitly requested:

7. `.coding-workflow/local-gates.json` — start from `templates/consumer-local-gates.json` and tailor real local gate profiles for THIS repo.
   - product repos own commands, env names, coverage mapping, and profile ids;
   - missing env may produce skipped/partial evidence, never covered/passed evidence;
   - local gate evidence is not hosted CI passing unless the product repo explicitly proves equivalent coverage.

8. `.coding-workflow/deploy.staging.json` — start from `templates/consumer-deploy-staging.json` and tailor real staging target config.
   - use real target host alias, repo root, service ids, health URL, smoke command, audit path, and log paths;
   - choose explicit `healthAttempts`, `healthIntervalSeconds`, `logExcerptLines`, and any SSH timeout settings;
   - do not write secrets, signed URLs, or tokens into config;
   - keep production promotion out of scope unless the human explicitly requests a separate production workflow.

9. Add portable wrappers only if useful:
   ```bash
   CODING_WORKFLOW="${CODING_WORKFLOW:-$HOME/Programs/coding-workflow}"
   node "$CODING_WORKFLOW/scripts/local-pr-gate.mjs" --profile docs --config .coding-workflow/local-gates.json
   node "$CODING_WORKFLOW/scripts/deploy-remote-staging.mjs" --config .coding-workflow/deploy.staging.json --target TARGET --ref REF_OR_SHA --dry-run
   ```
   Do not hardcode `/Users/.../coding-workflow`.

10. Validate CI/CD adoption:
   - run at least one local gate profile and report `passed` / `partial` / `failed` honestly;
   - run `service-manager-plan.mjs` against the staging config;
   - run `deploy-remote-staging.mjs --dry-run` first;
   - use `ci-diagnose-pr.mjs` before recommending local fallback;
   - generate `self-hosted-runner-plan.mjs` output only when diagnostics show repeated hosted-runner unavailability and local CI is insufficient.

FINALLY, tell the human the prerequisites only THEY can do (you cannot): 
   (a) enable the repo setting "Automatically delete head branches"; 
   (b) add CODING_WORKFLOW_TOKEN if the tooling repo is private, or make it public;
   (c) run `codex login` or `claude` login on any local/self-hosted runner used for subscription CLI review;
   (d) only add ANTHROPIC_API_KEY / ANTHROPIC_MODEL later if the team explicitly opts back into metered API AI review.
   (e) confirm staging host access, service-manager persistence, and any GitHub runner registration token if CI/CD adoption is requested.

Boundaries: do not embed/vendor the tooling; do not implement auto-merge; do not write secrets into the repo; do not fabricate passing status or data; do not auto-promote production; do not auto-register runners or store runner tokens; the non-AI gate is the real safety net and must run independently of any AI.
````
