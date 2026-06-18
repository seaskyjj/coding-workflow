#!/usr/bin/env node
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import {
  ensureDir,
  execGh,
  fail,
  markdownTable,
  nowIso,
  outputDirDefault,
  parseArgs,
  redact,
  writeJsonFile,
} from './cicd-lib.mjs';

function lower(value) {
  return String(value ?? '').toLowerCase();
}

function normalizeConclusion(item) {
  const status = lower(item.status ?? item.state);
  const conclusion = lower(item.conclusion ?? item.state);
  if (['queued', 'in_progress', 'pending', 'waiting', 'requested'].includes(status)
    || ['pending'].includes(conclusion)) {
    return 'pending';
  }
  if (['success', 'successful', 'completed'].includes(conclusion) || conclusion === 'neutral') return 'success';
  if (['skipped'].includes(conclusion)) return 'skipped';
  if (['cancelled', 'canceled', 'timed_out', 'stale'].includes(conclusion)) return 'transient_or_cancelled';
  if (['action_required', 'startup_failure'].includes(conclusion)) return 'workflow_configuration';
  if (['failure', 'failed', 'error'].includes(conclusion)) return 'failure';
  return conclusion || status || 'unknown';
}

export function classifyCheck(item, logText = '') {
  const text = lower([
    item.name,
    item.context,
    item.workflowName,
    item.displayTitle,
    item.conclusion,
    item.status,
    item.state,
    logText,
  ].filter(Boolean).join('\n'));
  const conclusion = normalizeConclusion(item);

  if (text.includes('api review skipped') || text.includes('metered api ai review is intentionally disabled')) {
    return 'metered_api_review_skip';
  }
  if (conclusion === 'pending') return 'pending';
  if (conclusion === 'success' || conclusion === 'skipped') return 'passing';
  if (conclusion === 'transient_or_cancelled') return 'transient_or_cancelled';
  if (conclusion === 'workflow_configuration') return 'workflow_configuration';
  if (/billing|quota|spending limit|payment required|minutes quota/.test(text)) return 'quota_or_billing';
  if (/no hosted runner|hosted runner unavailable|waiting for a runner|all eligible runners are busy|requested labels.*not found|no runner matching/.test(text)) {
    return 'hosted_runner_unavailable';
  }
  if (/invalid workflow|workflow syntax|yaml|did not match any jobs|the workflow is not valid|unrecognized named-value/.test(text)) {
    return 'workflow_configuration';
  }
  if (conclusion === 'failure') return 'test_failure';
  return 'unknown_failure';
}

function normalizeCheckRollup(items) {
  return (items ?? []).map((item) => ({
    name: item.name ?? item.context ?? item.workflowName ?? item.displayTitle ?? 'unnamed check',
    status: item.status ?? item.state ?? null,
    conclusion: item.conclusion ?? item.state ?? null,
    detailsUrl: item.detailsUrl ?? item.targetUrl ?? null,
    classification: classifyCheck(item),
  }));
}

function classifyRun(run, logText = '') {
  return {
    databaseId: run.databaseId ?? run.id ?? null,
    name: run.name ?? run.workflowName ?? 'unnamed run',
    workflowName: run.workflowName ?? null,
    status: run.status ?? null,
    conclusion: run.conclusion ?? null,
    event: run.event ?? null,
    createdAt: run.createdAt ?? null,
    updatedAt: run.updatedAt ?? null,
    classification: classifyCheck(run, logText),
    logExcerpt: logText ? redact(logText) : null,
  };
}

function recommendationFor(classifications) {
  const set = new Set(classifications);
  const recommendations = [];
  if (set.has('pending')) recommendations.push('wait_for_pending_checks');
  if (set.has('workflow_configuration')) recommendations.push('fix_workflow_configuration');
  if (set.has('test_failure')) recommendations.push('fix_product_tests');
  if (set.has('quota_or_billing')) recommendations.push('resolve_quota_or_billing');
  if (set.has('transient_or_cancelled')) recommendations.push('rerun_or_wait_for_transient_checks');
  if (set.has('hosted_runner_unavailable')) recommendations.push('local_fallback_may_be_useful');
  const hostedOutageCount = classifications.filter((item) => item === 'hosted_runner_unavailable').length;
  if (hostedOutageCount >= 2) recommendations.push('self_hosted_runner_plan_may_be_warranted');
  if (recommendations.length === 0 && classifications.every((item) => item === 'passing' || item === 'metered_api_review_skip')) {
    recommendations.push('no_action_required');
  }
  if (recommendations.length === 0) recommendations.push('needs_human_triage');
  return recommendations;
}

function readPr(repo, pr) {
  const json = execGh(['pr', 'view', String(pr), '--repo', repo, '--json', 'number,url,title,headRefName,baseRefName,headRefOid,statusCheckRollup']);
  return JSON.parse(json);
}

function listRuns(repo, branch, limit) {
  const json = execGh([
    'run',
    'list',
    '--repo',
    repo,
    '--branch',
    branch,
    '--limit',
    String(limit),
    '--json',
    'databaseId,status,conclusion,name,event,workflowName,createdAt,updatedAt,displayTitle',
  ]);
  return JSON.parse(json);
}

function failedLogExcerpt(repo, runId, lineLimit) {
  try {
    const raw = execGh(['run', 'view', String(runId), '--repo', repo, '--log-failed']);
    return raw.split('\n').slice(-lineLimit).join('\n');
  } catch (error) {
    return `failed log unavailable: ${error.message}`;
  }
}

export function buildDiagnostics({ repo, pr, prData, runs, logExcerpts = {}, historyLimit, failedLogLines }) {
  const checks = normalizeCheckRollup(prData.statusCheckRollup);
  const runHistory = runs.map((run) => classifyRun(run, logExcerpts[run.databaseId] ?? ''));
  const classifications = [
    ...checks.map((item) => item.classification),
    ...runHistory.map((item) => item.classification),
  ];
  return {
    schemaVersion: 1,
    kind: 'ci-diagnostics',
    generatedAt: nowIso(),
    repo,
    pr: Number(pr),
    prUrl: prData.url ?? null,
    headRefName: prData.headRefName ?? null,
    baseRefName: prData.baseRefName ?? null,
    headSha: prData.headRefOid ?? null,
    historyLimit,
    failedLogLines,
    checks,
    runHistory,
    recommendation: recommendationFor(classifications),
    classificationCounts: classifications.reduce((acc, item) => {
      acc[item] = (acc[item] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

export function renderDiagnosticsMarkdown(diagnostics) {
  const checkRows = diagnostics.checks.map((check) => [
    check.name,
    check.status ?? '',
    check.conclusion ?? '',
    check.classification,
  ]);
  const runRows = diagnostics.runHistory.map((run) => [
    run.databaseId ?? '',
    run.name,
    run.status ?? '',
    run.conclusion ?? '',
    run.classification,
  ]);
  return `<!-- coding-workflow-ci-diagnostics -->
# CI Diagnostics

- repo: ${diagnostics.repo}
- PR: ${diagnostics.pr}
- headSha: ${diagnostics.headSha ?? 'not available'}
- generatedAt: ${diagnostics.generatedAt}
- recommendation: ${diagnostics.recommendation.join(', ')}

## Status Checks

${checkRows.length ? markdownTable(['check', 'status', 'conclusion', 'classification'], checkRows) : 'No status checks returned by GitHub.'}

## Workflow Runs

${runRows.length ? markdownTable(['run id', 'name', 'status', 'conclusion', 'classification'], runRows) : 'No workflow runs returned for the PR branch within the requested history.'}

## Boundary

This is diagnostic evidence. It does not turn local evidence into hosted CI passing, and it does not approve or merge the PR.
`;
}

function upsertComment(repo, pr, body) {
  const comments = JSON.parse(execGh(['api', `repos/${repo}/issues/${pr}/comments`, '--paginate']));
  const existing = comments.find((comment) => String(comment.body ?? '').includes('<!-- coding-workflow-ci-diagnostics -->'));
  if (existing) {
    execGh(['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${existing.id}`, '--input', '-'], { input: JSON.stringify({ body }) });
    return { action: 'updated', id: existing.id };
  }
  const created = JSON.parse(execGh(['api', '-X', 'POST', `repos/${repo}/issues/${pr}/comments`, '--input', '-'], { input: JSON.stringify({ body }) }));
  return { action: 'created', id: created.id };
}

export async function diagnosePr(options) {
  const prData = options.prData ?? readPr(options.repo, options.pr);
  const runs = options.runs ?? listRuns(options.repo, prData.headRefName, options.historyLimit);
  const logExcerpts = {};
  if (options.includeFailedLogs) {
    for (const run of runs) {
      const classification = classifyCheck(run);
      if (!['passing', 'pending', 'metered_api_review_skip'].includes(classification) && run.databaseId) {
        logExcerpts[run.databaseId] = failedLogExcerpt(options.repo, run.databaseId, options.failedLogLines);
      }
    }
  }
  const diagnostics = buildDiagnostics({
    repo: options.repo,
    pr: options.pr,
    prData,
    runs,
    logExcerpts,
    historyLimit: options.historyLimit,
    failedLogLines: options.failedLogLines,
  });
  const outputDir = path.resolve(options.outputDir ?? outputDirDefault('ci-diagnostics', `pr-${options.pr}`));
  ensureDir(outputDir);
  const jsonPath = path.join(outputDir, 'ci-diagnostics.json');
  const mdPath = path.join(outputDir, 'ci-diagnostics.md');
  writeJsonFile(jsonPath, diagnostics);
  const markdown = redact(renderDiagnosticsMarkdown(diagnostics));
  writeFileSync(mdPath, markdown, 'utf8');
  let comment = null;
  if (options.postComment) {
    comment = upsertComment(options.repo, options.pr, markdown);
  }
  return { diagnostics, jsonPath, mdPath, comment };
}

async function main() {
  const args = parseArgs();
  if (args['--help']) {
    console.log('Usage: node scripts/ci-diagnose-pr.mjs --repo OWNER/REPO --pr N [--history-limit 20] [--post-comment] [--include-failed-logs --failed-log-lines N] [--json]');
    return;
  }
  if (!args['--repo']) fail('need --repo OWNER/REPO');
  if (!args['--pr']) fail('need --pr N');
  const historyLimit = Number(args['--history-limit'] ?? 20);
  const includeFailedLogs = Boolean(args['--include-failed-logs']);
  if (includeFailedLogs && !args['--failed-log-lines']) fail('--failed-log-lines N is required with --include-failed-logs');
  const failedLogLines = args['--failed-log-lines'] ? Number(args['--failed-log-lines']) : null;
  if (!Number.isInteger(historyLimit) || historyLimit <= 0) fail('--history-limit must be a positive integer');
  if (failedLogLines != null && (!Number.isInteger(failedLogLines) || failedLogLines <= 0)) fail('--failed-log-lines must be a positive integer');
  try {
    const { diagnostics, mdPath } = await diagnosePr({
      repo: args['--repo'],
      pr: args['--pr'],
      historyLimit,
      failedLogLines,
      outputDir: args['--output-dir'],
      postComment: Boolean(args['--post-comment']),
      includeFailedLogs,
    });
    if (args['--json']) {
      console.log(JSON.stringify(diagnostics, null, 2));
    } else {
      console.log(redact(`CI diagnostics written: ${mdPath}`));
    }
  } catch (error) {
    fail(redact(error.message), 2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
