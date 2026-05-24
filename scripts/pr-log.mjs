#!/usr/bin/env node
// pr-log.mjs — build pr_log records DERIVED from GitHub (via `gh`). Never hand-edit pr_log.jsonl.
//
// CLI:
//   node scripts/pr-log.mjs --repo owner/name --pr 12 [--out pr_log.jsonl]
//   node scripts/pr-log.mjs --repo owner/name --backfill [--out pr_log.jsonl]   # rebuild from all PRs
//
// Also exports buildPrRecord() / appendRecord() for ai-review.mjs.

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const TASK_ID_PATTERN = new RegExp(
  process.env.TASK_ID_PATTERN ?? '\\b(ST-[A-Z0-9-]+|ACT-[A-Z0-9-]+|[A-Z]{2,}-\\d+)\\b',
);

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

const PR_FIELDS = [
  'number', 'title', 'body', 'headRefOid', 'baseRefName', 'state',
  'author', 'createdAt', 'mergedAt', 'additions', 'deletions', 'changedFiles',
  'statusCheckRollup',
].join(',');

export function buildPrRecord(repo, pr) {
  const raw = JSON.parse(gh(['pr', 'view', String(pr), '--repo', repo, '--json', PR_FIELDS]));
  const state = raw.mergedAt ? 'merged' : String(raw.state ?? '').toLowerCase();
  const ci = {};
  for (const c of raw.statusCheckRollup ?? []) {
    const name = c.name ?? c.context ?? 'check';
    ci[name] = (c.conclusion ?? c.state ?? c.status ?? 'unknown').toLowerCase();
  }
  const taskMatch = (raw.body ?? '').match(TASK_ID_PATTERN);
  return {
    pr: raw.number,
    repo,
    title: raw.title,
    task_id: taskMatch ? taskMatch[1] : null,
    head_sha: raw.headRefOid,
    base: raw.baseRefName,
    state,
    author: raw.author?.login ?? null,
    created_at: raw.createdAt,
    merged_at: raw.mergedAt ?? null,
    files_changed: raw.changedFiles ?? null,
    additions: raw.additions ?? null,
    deletions: raw.deletions ?? null,
    ci,
    logged_at: new Date().toISOString(),
  };
}

export function appendRecord(outPath, record) {
  mkdirSync(dirname(outPath), { recursive: true });
  appendFileSync(outPath, JSON.stringify(record) + '\n');
}

function parseArgs(argv) {
  const out = { out: 'pr_log.jsonl' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '--pr') out.pr = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--backfill') out.backfill = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.repo) {
    console.error('usage: pr-log.mjs --repo owner/name (--pr N | --backfill) [--out pr_log.jsonl]');
    process.exit(2);
  }
  if (args.backfill) {
    const list = JSON.parse(gh(['pr', 'list', '--repo', args.repo, '--state', 'all', '--limit', '500', '--json', 'number']));
    for (const { number } of list) {
      appendRecord(args.out, buildPrRecord(args.repo, number));
      console.error(`logged PR #${number}`);
    }
    return;
  }
  if (!args.pr) {
    console.error('--pr N required unless --backfill');
    process.exit(2);
  }
  const record = buildPrRecord(args.repo, args.pr);
  appendRecord(args.out, record);
  console.error(`logged PR #${args.pr} -> ${args.out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
