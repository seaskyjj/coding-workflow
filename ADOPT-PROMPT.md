# Adoption prompt

Copy everything in the fenced block below into an agent (Claude Code / codex) running **inside the target product repo**. Replace `seaskyjj/coding-workflow` if your tooling repo lives elsewhere.

````
Adopt the reusable engineering workflow from the repo `seaskyjj/coding-workflow` into THIS project. Do not copy/vendor its scripts — reference it; only add small consumer config here.

FIRST, read these from coding-workflow (clone/fetch or read on GitHub): WORKFLOW.md, BOOTSTRAP.md, reviewer/CHECKLIST.md, templates/consumer-ci.yml, templates/consumer-ai-review.yml. Follow WORKFLOW.md's principles (source-of-truth vs derived; PR sizing; finding→test; branch hygiene; AI-review-yes/auto-merge-no; non-AI gate is the safety net).

THEN inspect THIS repo and do the following, opening ONE pull request (do not push to main directly):

1. .github/workflows/ci.yml — the non-AI gate. Start from templates/consumer-ci.yml and TAILOR to this repo's real toolchain/scripts:
   - detect the package manager and the actual build/test/typecheck/lint commands;
   - a fresh checkout has NO build output (dist) — if this is a cross-package monorepo, ensure dependent packages build in dependency order before typecheck/test (see the template's notes);
   - if any test shells out to system tools (e.g. ffmpeg), install them in the job (symptom: `spawn <tool> ENOENT`);
   - leave eval/visual/e2e gates commented unless they actually exist and can pass.

2. .github/workflows/ai-review.yml — copy templates/consumer-ai-review.yml; set `repository:` to the tooling repo; keep the graceful-degrade guards, concurrency, REVIEW_COMMENT_ID, and REVIEWER_OVERLAY as-is.

3. reviewer-overlay.md at the repo ROOT — write PROJECT-SPECIFIC review rules for THIS codebase (do NOT copy another project's overlay). Derive them from this repo's real invariants: read its ADRs/requirements/docs and the code, and encode the bug classes that would actually hurt here (authz/tenant boundaries, user-visible vs internal data, fail-closed rules, contract/snapshot sync, provenance, dev-only-not-in-prod, visual/responsive). Keep it tight; each rule should be checkable with `file:line` + a test.

4. If this repo has an agent instruction file (for example AGENTS.md, CLAUDE.md, or similar), add a small "PR Review Workflow" section. It should tell future agents to run a local cross-model Claude review after they create a PR when `claude` CLI is installed and logged in. Use a cwd-independent, configurable script path; do NOT hardcode `/Users/.../coding-workflow`:

   ```bash
   REPO_ROOT="$(git rev-parse --show-toplevel)"
   REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)"
   PR="$(gh pr view --json number --jq .number 2>/dev/null || true)"
   CODING_WORKFLOW="${CODING_WORKFLOW:-$HOME/Programs/coding-workflow}"
   AI_REVIEW_SCRIPT="$CODING_WORKFLOW/scripts/ai-review.mjs"

   if [ ! -f "$AI_REVIEW_SCRIPT" ]; then
     echo "ai-review.mjs not found; skipping local Claude review. CODING_WORKFLOW=$CODING_WORKFLOW"
   elif [ -z "$REPO" ]; then
     echo "No GitHub repo found for this checkout; skipping local Claude review."
   elif [ -z "$PR" ]; then
     echo "No open PR found for the current branch; skipping local Claude review."
   elif command -v claude >/dev/null && claude --version >/dev/null 2>&1; then
     REVIEW_MODE="${REVIEW_MODE:-deep}" \
     REVIEW_PROFILE="${REVIEW_PROFILE:-standard}" \
     MAX_FINDINGS="${MAX_FINDINGS:-12}" \
     REVIEW_COMMENT_ID=claude-cli \
     REVIEWER_OVERLAY="$REPO_ROOT/reviewer-overlay.md" \
     PR_LOG_PATH="${TMPDIR:-/tmp}/coding-workflow-pr-log.local.jsonl" \
     node "$AI_REVIEW_SCRIPT" --backend claude-cli --repo "$REPO" --pr "$PR"
   else
     echo "claude CLI unavailable; rely on GitHub Action or manual review."
   fi
   ```

   Keep the guardrails explicit: this command posts/updates a PR review comment only; it must not auto-merge or replace the non-AI CI gate. If the agent instruction file is covered by tests or linting, add a small check so the snippet does not regress to a machine-local absolute path and still passes `REVIEWER_OVERLAY`.

5. Open the PR following the conventions:
   - branch name uses a type prefix: feat/ fix/ refactor/ perf/ ci/ chore/ build/ docs/ test/ (with a task id if one exists, e.g. ci/setup-coding-workflow);
   - PR body includes: a task id (or note none), scope, out-of-scope, acceptance criteria (验收), verification commands (验证), known gaps;
   - keep it one coherent change.

6. Verify and report:
   - the ci gate must pass on the PR (fix real failures it surfaces — that's the point; turn any fix into a test where applicable);
   - the ai-review job should run and skip gracefully (green) if the tooling repo or API key isn't configured yet.
   - if local `claude` CLI is available and logged in, run the local review command from step 4 once after opening the PR; if it is unavailable, report that explicitly instead of fabricating review status.

FINALLY, tell the human the prerequisites only THEY can do (you cannot): 
   (a) enable the repo setting "Automatically delete head branches"; 
   (b) add secret ANTHROPIC_API_KEY (and CODING_WORKFLOW_TOKEN if the tooling repo is private, or make it public); 
   (c) optional repo variable ANTHROPIC_MODEL.

Boundaries: do not embed/vendor the tooling; do not implement auto-merge; do not write secrets into the repo; do not fabricate passing status or data; the non-AI gate is the real safety net and must run independently of any AI.
````
