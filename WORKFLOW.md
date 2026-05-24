# WORKFLOW — lightweight AI-assisted engineering loop

This is the methodology. It is deliberately thin: every heavy control-plane concept is replaced by a tool that enforces state, so nothing depends on a human or AI "remembering to update a markdown table".

## 1. Roles (asymmetric review)

- **Implementer** (e.g. codex): turns a task card into a branch + PR. Does one thing per PR.
- **Reviewer** (e.g. Claude): independent review on the PR. Different agent than the implementer — never self-review for the security/policy lens. If you run **multiple** AI reviewers (e.g. Claude + Codex), give each a distinct `REVIEW_COMMENT_ID` so they upsert separate comments instead of overwriting each other.
- **Non-AI gate** (CI): typecheck / test / lint / eval-gate / visual. Runs regardless of either AI's opinion. The real safety net.
- **Human**: arbiter on disagreements, final merge, sign-off on security / irreversible / architectural changes.

## 2. PR sizing

Measure by **"one reviewable, independently-verifiable, revertable unit"**, not by line count.

A PR should:
1. **Do one thing** — one task-card / one capability. If the title needs "and", it's two PRs.
2. **Leave `main` green** (typecheck + tests pass after merge).
3. **Be reviewable in one sitting** — real diff ideally < ~400 lines; a coherent feature with mechanical/test bulk can be larger.
4. **Be revertable** without dragging unrelated changes.

Small PRs are the **cure** for long-horizon-task fragility, not extra overhead: they bound blast radius and give frequent green checkpoints. Prefer a sequence of small reviewed units over one heroic long autonomous run.

## 3. The ratchet: every finding becomes a test

A reviewer finding that is a real bug must, **in the same PR**, become a regression test (or an executable invariant). "Fix and re-review" is not enough — without an assertion the same class returns. This is what makes the loop get better over time instead of re-finding the same bugs.

Coverage % is not the goal (it measures executed lines, not asserted invariants). Prefer **invariant / property / negative tests** for the recurring classes (see `reviewer/CHECKLIST.md`) over more example tests.

## 4. The loop

```
task card ──▶ implementer: branch + PR (one capability)
                 │
                 ▼
        CI non-AI gate runs (typecheck/test/lint/eval/visual)
                 │
                 ▼
        reviewer (auto on PR): structured findings + verdict
                 │
        findings? ──yes──▶ implementer: fix + add regression test ──▶ (re-review)
                 │no
                 ▼
        human: approve + merge   (auto-merge is NOT allowed)
                 │
                 ▼
        pr-log appended (derived from GitHub) for later analysis
```

## 5. Source of truth vs derived (anti-drift)

| Thing | Source of truth | Notes |
| --- | --- | --- |
| Task spec | task card / requirement doc in product repo | human/AI input — fine as a file |
| Code + tests | git | tests co-located with code, never split out, never gitignored |
| PR / review state / lifecycle | **GitHub** (PR status, comments, checks) | NOT a hand-maintained markdown registry |
| Decisions | ADRs in product repo | versioned with code |
| `pr_log.jsonl` | **derived from GitHub** via `scripts/pr-log.mjs` | regenerable export; commit only as a convenience snapshot, never hand-edit |

## 6. What goes in which repo (repo management)

- **Product repo (monorepo for one product)**: product code, **tests (co-located)**, migrations, ADRs/requirements/arch/status docs, CI workflows. Keep it one repo per product; do not split packages into separate repos prematurely.
- **gitignore only**: local/derived/secret — `node_modules`, build output, `.venv`, `tmp/`, local stores, model weights (use LFS/external), `.env`, diagnostic bundles. Never gitignore product code, tests, or decision docs.
- **This `coding-workflow` repo**: cross-project process tooling (reviewer checklist, pr-log generator, CI/Action templates, this methodology). Consumed by product repos, not embedded.

**When to actually split a product into multiple repos** — only on a real boundary:
- different release cadence / versioning (e.g. a published SDK vs the app),
- different access/ownership (open-source SDK vs proprietary backend),
- a genuinely independent consumer.

Not a reason to split: "repo feels big", "lots of tests", "lots of docs". Splitting imposes cross-repo version-coordination cost — the worst tax on a small team.

## 7. Branch hygiene

Branches are ephemeral work pointers — the durable record is PRs + git history + `pr_log`. Keep them from piling up:

- **Delete on merge (the main lever).** Enable GitHub repo setting *"Automatically delete head branches"*. Then only *open* (in-flight) branches ever remain — a small set, not a growing pile. This solves proliferation far more than naming does.
- **Prune locally.** Periodically: `git fetch --prune` (drop refs to deleted remote branches) and `git branch --merged main | grep -vE '^\*|main' | xargs -r git branch -d` (drop local merged branches).
- **Name by change type** (conventional style), so the branches that *are* open are filterable and the process/tooling ones are distinguishable from product work:

  | prefix | meaning | category |
  | --- | --- | --- |
  | `feat/` | product feature | functional |
  | `fix/` | bug fix | functional |
  | `refactor/` `perf/` | refactor / performance | functional |
  | `test/` | tests only | functional |
  | `ci/` `chore/` `build/` | CI / tooling / config | process |
  | `docs/` | docs | process |

  Add a task id when there is one: `feat/ST-P15-training-plan`, `ci/setup-workflows`. Filter examples:
  ```bash
  gh pr list --search "head:feat/ head:fix/"          # product work only
  git branch -r | grep -vE 'origin/(ci|chore|docs)/'  # hide process branches
  ```
- A **warn-only branch-name check** is in `scripts/pr-body-check.mjs` (regex `^(feat|fix|refactor|perf|ci|chore|build|docs|test)/.+`, override via `BRANCH_PREFIX_PATTERN`). It annotates, it does not block (use `--strict` to block).

## 8. Honest limits

Two AIs reviewing each other reduces but does not eliminate **correlated blind spots** (shared training-induced gaps). That is exactly why the non-AI gate (Section 1) and invariant tests (Section 3) must exist independently of AI judgment. AI review raises the find-rate; tests + CI provide the guarantee.
