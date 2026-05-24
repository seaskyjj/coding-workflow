#!/usr/bin/env node
// pr-body-check.mjs — lightweight PR-body + branch-name gate (trimmed on purpose).
// Checks the PR description carries the minimum a reviewer needs, and that the head
// branch follows the naming convention. WARNS by default (exit 0 + annotation); pass
// --strict to fail CI. Do NOT grow this into a heavy mandatory form — keep it small.
//
// Usage: node scripts/pr-body-check.mjs --repo owner/name --pr N [--strict]
// Requires `gh` authenticated.

import { execFileSync } from 'node:child_process';

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }
const strict = process.argv.includes('--strict');
const repo = arg('--repo') ?? process.env.GITHUB_REPOSITORY;
const pr = arg('--pr') ?? process.env.PR_NUMBER;
if (!repo || !pr) { console.error('need --repo owner/name and --pr N'); process.exit(2); }

const TASK_ID = new RegExp(process.env.TASK_ID_PATTERN ?? '\\b(ST-[A-Z0-9-]+|ACT-[A-Z0-9-]+|[A-Z]{2,}-\\d+)\\b');
// Branch prefix convention (see WORKFLOW.md "Branch hygiene"). Override with BRANCH_PREFIX_PATTERN.
const BRANCH_RE = new RegExp(process.env.BRANCH_PREFIX_PATTERN ?? '^(feat|fix|refactor|perf|ci|chore|build|docs|test)/.+');

const prJson = JSON.parse(execFileSync('gh', ['pr', 'view', String(pr), '--repo', repo, '--json', 'body,headRefName'], { encoding: 'utf8' }));
const body = prJson.body ?? '';
const branch = prJson.headRefName ?? '';

const issues = [];
// Minimal required PR-body signals (keep small):
const missing = [
  { name: 'task id (e.g. ST-Pxx)', ok: TASK_ID.test(body) },
  { name: 'acceptance criteria', ok: /验收|acceptance/i.test(body) },
  { name: 'verification commands', ok: /验证|verif|how to test|test plan/i.test(body) },
].filter((c) => !c.ok).map((c) => c.name);
if (missing.length > 0) {
  issues.push(`PR body missing: ${missing.join(', ')} (add task id, acceptance criteria, verification commands).`);
}
// Branch naming convention:
if (!BRANCH_RE.test(branch)) {
  issues.push(`branch "${branch}" should start with one of feat/ fix/ refactor/ perf/ ci/ chore/ build/ docs/ test/ (ideally with a task id, e.g. feat/ST-P15-...).`);
}

if (issues.length === 0) {
  console.log('PR body + branch check: OK');
  process.exit(0);
}
for (const msg of issues) {
  console.log(`::${strict ? 'error' : 'warning'}::${msg}`);
  console.error(msg);
}
process.exit(strict ? 1 : 0);
