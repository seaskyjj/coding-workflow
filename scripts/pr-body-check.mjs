#!/usr/bin/env node
// pr-body-check.mjs — lightweight PR-body gate (#1, trimmed on purpose).
// Checks the PR description carries the minimum a reviewer needs. WARNS by default
// (exit 0 + annotation); pass --strict to fail CI. Do NOT grow this into a heavy
// mandatory form — keep it to a few fields.
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
const body = JSON.parse(execFileSync('gh', ['pr', 'view', String(pr), '--repo', repo, '--json', 'body'], { encoding: 'utf8' })).body ?? '';

// Minimal required signals (keep small):
const checks = [
  { name: 'task id (e.g. ST-Pxx)', ok: TASK_ID.test(body) },
  { name: 'acceptance criteria', ok: /验收|acceptance/i.test(body) },
  { name: 'verification commands', ok: /验证|verif|how to test|test plan/i.test(body) },
];
const missing = checks.filter((c) => !c.ok).map((c) => c.name);

if (missing.length === 0) {
  console.log('PR body check: OK');
  process.exit(0);
}
const msg = `PR body missing: ${missing.join(', ')}. Add task id, acceptance criteria, and verification commands so review/CI can anchor on them.`;
// GitHub Actions annotation
console.log(`::${strict ? 'error' : 'warning'}::${msg}`);
console.error(msg);
process.exit(strict ? 1 : 0);
