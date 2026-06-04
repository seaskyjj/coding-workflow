#!/usr/bin/env node
// ai-review.mjs — self-contained AI PR reviewer.
// Reads a PR diff, reviews it through reviewer/CHECKLIST.md (+ optional project overlay),
// upserts ONE structured review comment, and appends a pr_log record.
//
// Backends (answers the API-cost question):
//   --backend claude-cli  -> shells out to `claude -p` (uses your Claude subscription/Max; no metered API key).
//                            Best for LOCAL or a persistent self-hosted runner where Claude Code is logged in.
//   --backend api         -> Anthropic Messages API (metered key). Best for ephemeral GitHub Actions.
//   default: env REVIEW_BACKEND or "api".
//
// Env:
//   REVIEW_BACKEND      api | claude-cli
//   ANTHROPIC_API_KEY   (required for api backend)
//   ANTHROPIC_MODEL     (api default below; or claude-cli model via CLAUDE_CLI_MODEL)
//   REVIEWER_OVERLAY    path to project-specific overlay md (else auto: .coding-workflow/reviewer-overlay.md or reviewer-overlay.md)
//   GITHUB_REPOSITORY   owner/name (auto in Actions) or pass --repo
//   PR_LOG_PATH         default pr_log.jsonl
//   REVIEW_FAIL_ON      "request_changes" to fail CI on that verdict (default: never fail)
//   REVIEW_MODE         deep | gate | confirm-fixes (default: deep)
//   REVIEW_PROFILE      standard | pilot_minimal (default: standard)
//   REVIEW_SYNTHESIS    0 disables deep-mode cross-batch synthesis (default: enabled for deep file-batched reviews)
//   MAX_DIFF_CHARS      default 200000  (large PRs are reviewed as file batches under this cap)
//   MAX_FINDINGS        default 12 for deep, 5 for gate/confirm-fixes/pilot_minimal
// Args: --repo owner/name --pr N [--backend api|claude-cli] [--overlay path]
//       [--review-mode deep|gate|confirm-fixes] [--review-profile standard|pilot_minimal] [--print-diff-plan]
//
// Requires `gh` authenticated (GITHUB_TOKEN/GH_TOKEN in Actions).

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { buildPrRecord, appendRecord } from './pr-log.mjs';

const API_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5';
const CLI_MODEL = process.env.CLAUDE_CLI_MODEL; // optional; else CLI default
const REVIEW_MODE = normalizeReviewMode(arg('--review-mode') ?? process.env.REVIEW_MODE ?? 'deep');
const REVIEW_PROFILE = normalizeReviewProfile(arg('--review-profile') ?? process.env.REVIEW_PROFILE ?? 'standard');
const MAX_DIFF_CHARS = Number(process.env.MAX_DIFF_CHARS ?? 200000);
const MAX_FINDINGS = Number(process.env.MAX_FINDINGS ?? defaultMaxFindings(REVIEW_MODE, REVIEW_PROFILE));
const REVIEW_SYNTHESIS_ENABLED = process.env.REVIEW_SYNTHESIS !== '0' && REVIEW_MODE === 'deep';
const SYNTHESIS_PATCH_CHARS = Number(process.env.SYNTHESIS_PATCH_CHARS ?? Math.min(120000, Math.floor(MAX_DIFF_CHARS * 0.6)));
const PR_LOG_PATH = process.env.PR_LOG_PATH ?? 'pr_log.jsonl';
// reviewer-scoped marker so multiple AI reviewers (claude / codex) don't overwrite each other's comment.
const REVIEWER_ID = process.env.REVIEW_COMMENT_ID ?? process.env.REVIEWER_ID ?? 'default';
const MARKER = `<!-- ai-review:${REVIEWER_ID} -->`;
const STATE_BEGIN = `<!-- ai-review-state:${REVIEWER_ID}`;
const STATE_END = `ai-review-state:end -->`;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasArg(name) {
  return process.argv.includes(name);
}
function normalizeReviewMode(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['deep', 'gate', 'confirm-fixes'].includes(normalized)) return normalized;
  throw new Error(`invalid REVIEW_MODE: ${value}. Expected deep, gate, or confirm-fixes.`);
}
function normalizeReviewProfile(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['standard', 'pilot_minimal'].includes(normalized)) return normalized;
  throw new Error(`invalid REVIEW_PROFILE: ${value}. Expected standard or pilot_minimal.`);
}
function defaultMaxFindings(reviewMode, reviewProfile) {
  if (reviewProfile === 'pilot_minimal') return 5;
  return reviewMode === 'deep' ? 12 : 5;
}
function gh(args, opts = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}
function ghJson(method, endpoint, payload) {
  return gh(['api', '-X', method, endpoint, '--input', '-'], { input: JSON.stringify(payload) });
}
function readSibling(rel) {
  return readFileSync(new URL(rel, import.meta.url), 'utf8');
}
function resolveOverlay() {
  const explicit = arg('--overlay') ?? process.env.REVIEWER_OVERLAY;
  if (explicit) return existsSync(explicit) ? readFileSync(explicit, 'utf8') : undefined;
  // Product overlay lives at the product-repo root only. Do NOT search `.coding-workflow*`
  // (that path is used to check out the tools repo in CI and would collide).
  if (existsSync('reviewer-overlay.md')) return readFileSync('reviewer-overlay.md', 'utf8');
  return undefined;
}

// ---- backends -------------------------------------------------------------
async function callApi(systemText, userText) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY required for --backend api');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: API_MODEL,
      max_tokens: 4096,
      system: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userText }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

function callClaudeCli(systemText, userText) {
  // Uses the logged-in Claude Code subscription (no metered API key).
  const cliArgs = ['-p'];
  if (CLI_MODEL) cliArgs.push('--model', CLI_MODEL);
  return execFileSync('claude', cliArgs, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    input: `${systemText}\n\n=== REVIEW TASK ===\n${userText}`,
  });
}

// ---- comment upsert (one living comment, not new each round) --------------
function listIssueComments(repo, pr) {
  const comments = JSON.parse(gh(['api', `repos/${repo}/issues/${pr}/comments`, '--paginate']));
  return comments;
}
function findExistingReviewComment(repo, pr) {
  return listIssueComments(repo, pr).find((c) => typeof c.body === 'string' && c.body.includes(MARKER));
}
function upsertComment(repo, pr, body) {
  const existing = findExistingReviewComment(repo, pr);
  if (existing) {
    ghJson('PATCH', `repos/${repo}/issues/comments/${existing.id}`, { body });
  } else {
    ghJson('POST', `repos/${repo}/issues/${pr}/comments`, { body });
  }
}

function loadPreviousReviewContext(repo, pr) {
  const commentState = parseReviewStateFromComment(findExistingReviewComment(repo, pr)?.body);
  if (commentState) {
    return { source: 'existing PR review comment', ...commentState };
  }
  const logState = readLatestReviewStateFromLog(repo, pr);
  if (logState) {
    return { source: PR_LOG_PATH, ...logState };
  }
  return undefined;
}

function parseReviewStateFromComment(body) {
  if (!body) return undefined;
  const start = body.indexOf(STATE_BEGIN);
  const end = body.indexOf(STATE_END, start);
  if (start < 0 || end < 0) return undefined;
  const jsonStart = body.indexOf('\n', start);
  if (jsonStart < 0 || jsonStart >= end) return undefined;
  try {
    return JSON.parse(body.slice(jsonStart, end).trim());
  } catch {
    return undefined;
  }
}

function readLatestReviewStateFromLog(repo, pr) {
  if (!existsSync(PR_LOG_PATH)) return undefined;
  const lines = readFileSync(PR_LOG_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const record = JSON.parse(lines[i]);
      if (String(record.repo) === String(repo) && String(record.pr) === String(pr) && record.review) {
        return {
          version: 1,
          verdict: record.review.verdict,
          summary: record.review.summary,
          findings: record.review.findings ?? [],
          reviewMode: record.review.mode,
          reviewProfile: record.review.profile,
          headSha: record.head_sha,
        };
      }
    } catch {
      // Ignore malformed derived log rows.
    }
  }
  return undefined;
}

async function review() {
  const repo = arg('--repo') ?? process.env.GITHUB_REPOSITORY;
  const pr = arg('--pr') ?? process.env.PR_NUMBER;
  const backend = arg('--backend') ?? process.env.REVIEW_BACKEND ?? 'api';
  if (!repo || !pr) throw new Error('need --repo owner/name and --pr N (or GITHUB_REPOSITORY/PR_NUMBER)');

  const meta = JSON.parse(gh(['pr', 'view', String(pr), '--repo', repo, '--json', 'title,body,baseRefName,headRefName']));
  const previousReview = loadPreviousReviewContext(repo, pr);
  const diffPlan = buildDiffPlan(repo, pr, meta);
  if (hasArg('--print-diff-plan')) {
    console.log(JSON.stringify(summarizeDiffPlan(diffPlan), null, 2));
    return;
  }

  let systemText = readSibling('../reviewer/CHECKLIST.md');
  const overlay = resolveOverlay();
  if (overlay) systemText += `\n\n# Project overlay (repo-specific rules — apply in addition to the above)\n\n${overlay}`;

  const promptTemplate = readSibling('../reviewer/review-prompt.md');
  const reviewResults = [];
  for (const batch of diffPlan.batches) {
    const userText = buildReviewUserText(promptTemplate, meta, batch, diffPlan, previousReview);
    const rawText = backend === 'claude-cli' ? callClaudeCli(systemText, userText) : await callApi(systemText, userText);
    reviewResults.push({ batch, rawText, parsed: parseReviewOrNeedsHuman(rawText, batch) });
  }

  if (shouldRunSynthesis(diffPlan, reviewResults)) {
    const batch = buildSynthesisBatch(diffPlan);
    const userText = buildSynthesisUserText(promptTemplate, meta, batch, diffPlan, reviewResults, previousReview);
    const rawText = backend === 'claude-cli' ? callClaudeCli(systemText, userText) : await callApi(systemText, userText);
    reviewResults.push({ batch, rawText, parsed: parseReviewOrNeedsHuman(rawText, batch) });
  }

  if (reviewResults.length === 0) {
    reviewResults.push({
      batch: { label: 'no reviewable file patches', paths: [], diff: '' },
      rawText: '',
      parsed: {
        verdict: 'needs_human',
        summary: 'No reviewable file patches were available from the PR files API.',
        findings: [],
        could_not_verify: [],
      },
    });
  }
  const parsed = mergeReviewResults(reviewResults, diffPlan);

  const comment = renderComment(parsed, reviewResults.map((r) => r.rawText).join('\n\n--- batch output ---\n\n'), diffPlan, overlay != null, backend, meta, previousReview);
  upsertComment(repo, pr, comment);

  const record = buildPrRecord(repo, pr);
  record.review = parsed
    ? { verdict: parsed.verdict, summary: parsed.summary, rounds: reviewResults.length, backend, overlay: overlay != null, mode: REVIEW_MODE, profile: REVIEW_PROFILE,
        findings: (parsed.findings ?? []).map((f) => ({ severity: f.severity, area: f.area, location: f.location, issue: f.issue, turned_into_test: null, status: 'open' })) }
    : { verdict: 'needs_human', summary: 'review output not machine-parseable', rounds: 1, backend, overlay: overlay != null, mode: REVIEW_MODE, profile: REVIEW_PROFILE, findings: [] };
  appendRecord(PR_LOG_PATH, record);

  const verdict = parsed?.verdict ?? 'needs_human';
  console.error(`[${backend}] verdict: ${verdict} (${parsed?.findings?.length ?? '?'} findings; mode=${REVIEW_MODE}; profile=${REVIEW_PROFILE})${diffPlan.mode === 'file-batches' ? ` [${diffPlan.batches.length} file batch(es)]` : ''}${diffPlan.partial ? ' [PARTIAL→needs_human]' : ''} -> ${repo}#${pr}`);
  if (process.env.REVIEW_FAIL_ON && verdict === process.env.REVIEW_FAIL_ON) process.exit(1);
}

function buildDiffPlan(repo, pr, meta) {
  const fullDiff = gh(['pr', 'diff', String(pr), '--repo', repo]);
  if (fullDiff.length <= MAX_DIFF_CHARS) {
    return {
      mode: 'full-diff',
      repo,
      pr,
      meta,
      fullDiffChars: fullDiff.length,
      batches: [{ label: 'full PR diff', paths: [], diff: fullDiff, chars: fullDiff.length }],
      criticalPatches: [],
      omittedFiles: [],
      partial: false,
    };
  }

  const files = sortReviewFiles(JSON.parse(gh(['api', `repos/${repo}/pulls/${pr}/files`, '--paginate'])));
  const batches = [];
  const omittedFiles = [];
  const criticalPatches = [];
  let current = { label: '', paths: [], parts: [], chars: 0 };

  const flush = () => {
    if (current.parts.length === 0) return;
    const batchNumber = batches.length + 1;
    batches.push({
      label: `file batch ${batchNumber}`,
      paths: current.paths,
      diff: current.parts.join('\n\n'),
      chars: current.chars,
    });
    current = { label: '', paths: [], parts: [], chars: 0 };
  };

  for (const file of files) {
    if (!file.patch) {
      omittedFiles.push(buildOmittedFile(repo, pr, meta, file, 'GitHub PR files API did not return a patch for this file'));
      continue;
    }
    const fileDiff = renderFilePatch(file);
    if (isCriticalReviewFile(file.filename)) {
      criticalPatches.push({
        path: file.filename,
        priority: reviewFilePriority(file),
        diff: fileDiff,
        chars: fileDiff.length,
      });
    }
    if (fileDiff.length > MAX_DIFF_CHARS) {
      omittedFiles.push(buildOmittedFile(repo, pr, meta, file, `single-file patch length ${fileDiff.length} exceeds MAX_DIFF_CHARS (${MAX_DIFF_CHARS})`));
      continue;
    }
    if (current.parts.length > 0 && current.chars + fileDiff.length > MAX_DIFF_CHARS) {
      flush();
    }
    current.parts.push(fileDiff);
    current.paths.push(file.filename);
    current.chars += fileDiff.length;
  }
  flush();

  return {
    mode: 'file-batches',
    repo,
    pr,
    meta,
    fullDiffChars: fullDiff.length,
    batches: batches.map((batch, index) => ({ ...batch, label: `file batch ${index + 1}/${batches.length}` })),
    criticalPatches,
    omittedFiles,
    partial: omittedFiles.length > 0,
  };
}

function sortReviewFiles(files) {
  return [...files].sort((a, b) => {
    const byPriority = reviewFilePriority(a) - reviewFilePriority(b);
    if (byPriority !== 0) return byPriority;
    return String(a.filename ?? '').localeCompare(String(b.filename ?? ''));
  });
}

function reviewFilePriority(file) {
  const path = String(file.filename ?? '').toLowerCase();
  if (isTestPath(path)) return 7;
  if (/(^|\/)(docs?|readme|changelog|handoffs?)\//.test(path) || /\.(md|mdx|txt)$/.test(path)) return 8;
  if (/(^|\/)(package-lock|pnpm-lock|yarn\.lock|dist|build|generated|snapshot)/.test(path)) return 9;
  if (/(^|\/)(p0-http-server|[^/]*http[^/]*server|[^/]*handler|[^/]*router|[^/]*route|auth|authorization|session|viewer|tenant|rls|policy|permission|access|audit)/.test(path)) return 0;
  if (/(^|\/)(migrations?|schema|db|database|kysely|repository|store).*(\.sql|\.ts|\.js|\.mjs)$/.test(path) || /\.sql$/.test(path)) return 1;
  if (/(^|\/)(src|packages|apps|services|server|api)\//.test(path)) return 2;
  return 5;
}

function isCriticalReviewFile(path) {
  return reviewFilePriority({ filename: path }) <= 2;
}

function isTestPath(path) {
  return /(^|\/)(__tests__|test|tests|spec|fixtures|mocks|snapshots)(\/|$)|(\.|-)(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

function renderFilePatch(file) {
  const status = file.status ? `status=${file.status}` : 'status=unknown';
  const stats = `additions=${file.additions ?? '?'} deletions=${file.deletions ?? '?'} changes=${file.changes ?? '?'}`;
  return [
    `diff --git a/${file.filename} b/${file.filename}`,
    `# ${status} ${stats}`,
    file.patch,
  ].join('\n');
}

function buildOmittedFile(repo, pr, meta, file, reason) {
  const filename = file.filename ?? '(unknown)';
  return {
    path: filename,
    reason,
    apiCommand: `gh api repos/${repo}/pulls/${pr}/files --paginate --jq '.[] | select(.filename=="${escapeDoubleQuoted(filename)}") | .patch'`,
    localCommand: `gh pr checkout ${pr} --repo ${repo} && git diff origin/${meta.baseRefName ?? 'BASE'}...HEAD -- "${escapeDoubleQuoted(filename)}"`,
  };
}

function buildReviewUserText(promptTemplate, meta, batch, diffPlan, previousReview) {
  const batchNote = diffPlan.mode === 'file-batches'
    ? `\n\nDIFF MODE: file-batched review because full PR diff is ${diffPlan.fullDiffChars} chars, above MAX_DIFF_CHARS=${MAX_DIFF_CHARS}.\nBATCH: ${batch.label}\nFILES IN THIS BATCH:\n${batch.paths.map((p) => `- ${p}`).join('\n') || '(none)'}\n`
    : '';
  return `${promptTemplate}\n\n---\n${reviewModeInstructions(previousReview)}\n\nPR TITLE: ${meta.title}\n\nPR BODY:\n${meta.body ?? '(none)'}${batchNote}\n\nDIFF:\n\n${batch.diff}`;
}

function reviewModeInstructions(previousReview) {
  const previous = REVIEW_MODE === 'deep' ? '' : formatPreviousReview(previousReview);
  const profile = REVIEW_PROFILE === 'pilot_minimal'
    ? [
        'REVIEW PROFILE: pilot_minimal.',
        'This PR is for a temporary/pilot path. Keep review focused on: main path can run, obvious crash/race/resource leaks, auth/tenant/secret/PII/live-URL leakage, fail-closed behavior, minimum tests, and explicit implemented/partial/not-production labeling.',
        'Do NOT spend findings on broad architecture polish, production-scale concurrency/lifecycle, or low-value ergonomics unless they create a concrete blocker/regression for the pilot.',
      ].join('\n')
    : 'REVIEW PROFILE: standard.';
  const mode = {
    deep: [
      'REVIEW MODE: deep.',
      `Find as many substantiated checklist/overlay issues as are useful, capped at MAX_FINDINGS=${MAX_FINDINGS}. Order by severity and exploitability.`,
      'For large file-batched PRs, review this batch seriously but do not claim files outside this batch were verified.',
    ],
    gate: [
      'REVIEW MODE: gate.',
      'This is a follow-up review after fixes. Only report blockers, regressions, newly introduced high-value issues, or previous findings that remain materially unresolved.',
      'Do not chase every low advisory. Under an approve verdict, low advisory notes should be rare and high-signal.',
    ],
    'confirm-fixes': [
      'REVIEW MODE: confirm-fixes.',
      'Only verify the previous findings/fix claims. Return findings only for previous issues that are still open, fixes that introduced a blocker/regression, or a newly obvious security/data-loss issue in the touched fix area.',
      'Do not perform a fresh broad review and do not enumerate unrelated low advisory findings.',
    ],
  }[REVIEW_MODE].join('\n');
  return [mode, profile, previous].filter(Boolean).join('\n\n');
}

function formatPreviousReview(previousReview) {
  if (!previousReview?.findings?.length) return '';
  const findings = previousReview.findings.slice(0, 20).map((finding, index) => {
    const severity = finding.severity ?? '?';
    const area = finding.area ?? '?';
    const location = finding.location ?? '?';
    const issue = finding.issue ?? finding.summary ?? '(no issue text)';
    return `${index + 1}. [${severity}/${area}] ${location}: ${issue}`;
  }).join('\n');
  return [
    `PREVIOUS REVIEW CONTEXT (source: ${previousReview.source ?? 'unknown'}).`,
    `Previous verdict: ${previousReview.verdict ?? 'unknown'}.`,
    'Use this context to avoid re-running a broad review during gate/confirm-fixes mode.',
    findings,
  ].join('\n');
}

function shouldRunSynthesis(diffPlan, reviewResults) {
  return REVIEW_SYNTHESIS_ENABLED &&
    diffPlan.mode === 'file-batches' &&
    diffPlan.batches.length > 1 &&
    reviewResults.length > 0 &&
    diffPlan.criticalPatches?.length > 0;
}

function buildSynthesisBatch(diffPlan) {
  const patches = selectSynthesisPatches(diffPlan);
  return {
    label: `cross-batch synthesis (${patches.length} critical file patch(es))`,
    paths: patches.map((patch) => patch.path),
    diff: patches.map((patch) => patch.diff).join('\n\n'),
    chars: patches.reduce((sum, patch) => sum + patch.chars, 0),
    synthesis: true,
  };
}

function selectSynthesisPatches(diffPlan) {
  const selected = [];
  let chars = 0;
  for (const patch of [...(diffPlan.criticalPatches ?? [])].sort((a, b) => a.priority - b.priority || a.path.localeCompare(b.path))) {
    if (patch.chars > SYNTHESIS_PATCH_CHARS) continue;
    if (selected.length > 0 && chars + patch.chars > SYNTHESIS_PATCH_CHARS) break;
    selected.push(patch);
    chars += patch.chars;
  }
  return selected;
}

function buildSynthesisUserText(promptTemplate, meta, batch, diffPlan, reviewResults, previousReview) {
  const batchSummaries = reviewResults.map((result, index) => {
    const parsed = result.parsed ?? {};
    const findings = (parsed.findings ?? []).map((finding, findingIndex) =>
      `  ${findingIndex + 1}. [${finding.severity}/${finding.area}] ${finding.location}: ${finding.issue}`
    ).join('\n') || '  (no findings)';
    return [
      `BATCH ${index + 1}: ${result.batch.label}`,
      `Files: ${(result.batch.paths ?? []).join(', ') || '(none)'}`,
      `Verdict: ${parsed.verdict ?? 'unknown'}`,
      `Summary: ${parsed.summary ?? '(none)'}`,
      'Findings:',
      findings,
    ].join('\n');
  }).join('\n\n');
  const omitted = (diffPlan.omittedFiles ?? []).map((file) => `- ${file.path}: ${file.reason}`).join('\n') || '(none)';
  return [
    promptTemplate,
    '---',
    reviewModeInstructions(previousReview),
    '',
    'SYNTHESIS PASS: review cross-file/global invariants across the batch summaries and the critical file patches below.',
    'Do not repeat per-batch low advisory findings unless they combine into a blocker/regression. Focus on authz/tenant boundaries, call-chain contract drift, RLS/migration invariants, fail-closed behavior, secret/PII leakage, and omitted critical files.',
    '',
    `PR TITLE: ${meta.title}`,
    '',
    `PR BODY:\n${meta.body ?? '(none)'}`,
    '',
    `FULL DIFF CHARS: ${diffPlan.fullDiffChars}; MAX_DIFF_CHARS=${MAX_DIFF_CHARS}; BATCHES=${diffPlan.batches.length}`,
    '',
    `OMITTED FILES:\n${omitted}`,
    '',
    `PER-BATCH REVIEW RESULTS:\n${batchSummaries}`,
    '',
    `CRITICAL FILE PATCHES INCLUDED IN SYNTHESIS (${batch.chars} chars, cap ${SYNTHESIS_PATCH_CHARS}):`,
    '',
    batch.diff || '(none)',
  ].join('\n');
}

function parseReviewOrNeedsHuman(text, batch) {
  const parsed = parseReview(text);
  if (parsed) return parsed;
  return {
    verdict: 'needs_human',
    summary: `review output for ${batch.label} was not machine-parseable`,
    findings: [],
    could_not_verify: [`review output for ${batch.label} was not machine-parseable`],
  };
}

function mergeReviewResults(reviewResults, diffPlan) {
  const parsedResults = reviewResults.map((r) => r.parsed);
  const findings = parsedResults
    .flatMap((p) => p.findings ?? [])
    .sort((a, b) => findingRank(b) - findingRank(a))
    .slice(0, MAX_FINDINGS);
  const couldNotVerify = parsedResults.flatMap((p) => p.could_not_verify ?? []);

  if (diffPlan.mode === 'file-batches') {
    couldNotVerify.unshift(
      `Full PR diff was ${diffPlan.fullDiffChars} chars, so the runner reviewed ${diffPlan.batches.length} file batch(es) from GitHub pulls/{pr}/files patches instead of truncating the combined diff.`,
    );
  }
  if (diffPlan.omittedFiles.length > 0) {
    couldNotVerify.unshift(
      `One or more files were not reviewed from model input; overall verdict is forced to needs_human. Manual per-file patch command example: ${diffPlan.omittedFiles[0].apiCommand}`,
    );
    for (const omitted of diffPlan.omittedFiles) {
      couldNotVerify.push(`NOT reviewed: ${omitted.path} — ${omitted.reason}. Try: ${omitted.apiCommand} ; or after checkout: ${omitted.localCommand}`);
    }
  }

  const verdict = diffPlan.partial ? 'needs_human' : strongestVerdict(parsedResults.map((p) => p.verdict));
  const summaries = parsedResults.map((p) => p.summary).filter(Boolean);
  const summaryPrefix = diffPlan.mode === 'file-batches'
    ? `Reviewed as ${diffPlan.batches.length} file batch(es) because the full diff exceeded MAX_DIFF_CHARS. `
    : '';
  const synthesis = reviewResults.some((result) => result.batch?.synthesis);
  const synthesisNote = synthesis ? 'A cross-batch synthesis pass was also run over batch summaries and critical file patches. ' : '';
  return {
    verdict,
    summary: `${summaryPrefix}${synthesisNote}${summaries.join(' / ') || 'Review completed.'}`,
    findings,
    could_not_verify: uniqueStrings(couldNotVerify),
  };
}

function strongestVerdict(verdicts) {
  const order = { approve: 0, approve_after_fixes: 1, request_changes: 2, needs_human: 3 };
  return verdicts.reduce((strongest, verdict) => {
    const normalized = Object.prototype.hasOwnProperty.call(order, verdict) ? verdict : 'needs_human';
    return order[normalized] > order[strongest] ? normalized : strongest;
  }, 'approve');
}

function findingRank(finding) {
  const severity = { high: 300, med: 200, low: 100 }[finding.severity] ?? 0;
  const area = { A_authz: 50, B_contract: 40, C_policy: 30, D_visual: 20, E_reliability: 10 }[finding.area] ?? 0;
  return severity + area;
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function summarizeDiffPlan(diffPlan) {
  return {
    mode: diffPlan.mode,
    fullDiffChars: diffPlan.fullDiffChars,
    maxDiffChars: MAX_DIFF_CHARS,
    reviewMode: REVIEW_MODE,
    reviewProfile: REVIEW_PROFILE,
    maxFindings: MAX_FINDINGS,
    synthesisEnabled: REVIEW_SYNTHESIS_ENABLED,
    partial: diffPlan.partial,
    batches: diffPlan.batches.map((batch) => ({
      label: batch.label,
      chars: batch.chars,
      files: batch.paths,
    })),
    criticalFiles: (diffPlan.criticalPatches ?? []).map((patch) => ({
      path: patch.path,
      chars: patch.chars,
      priority: patch.priority,
    })),
    omittedFiles: diffPlan.omittedFiles,
  };
}

function escapeDoubleQuoted(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function parseReview(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  try { return JSON.parse(candidate); } catch { return undefined; }
}

function renderComment(parsed, rawText, diffPlan, hasOverlay, backend, meta, previousReview) {
  const state = parsed ? renderReviewState(parsed, meta, diffPlan, previousReview) : '';
  const foot = `\n\n---\n_Advisory (${backend}${hasOverlay ? ' + project overlay' : ''}; mode=${REVIEW_MODE}; profile=${REVIEW_PROFILE}). The non-AI CI gate is the safety net. Each real-bug finding should become a regression test in this PR._`;
  if (!parsed) {
    return `${MARKER}\n${state}\n## 🤖 AI review — needs human (unparseable output)\n${diffPlan.partial ? '> ⚠️ diff review was partial\n\n' : ''}\n${rawText}${foot}`;
  }
  const sev = { high: '🔴', med: '🟡', low: '⚪' };
  const lines = [
    MARKER,
    state,
    `## 🤖 AI review — verdict: \`${parsed.verdict}\``,
    `Mode: \`${REVIEW_MODE}\` · Profile: \`${REVIEW_PROFILE}\` · Finding cap: \`${MAX_FINDINGS}\``,
    parsed.summary ? `\n${parsed.summary}\n` : '',
    diffPlan.partial ? '> ⚠️ one or more file patches were unavailable or over the size cap — review is **partial**, forced to `needs_human`.\n' : '',
  ];
  const findings = parsed.findings ?? [];
  if (findings.length === 0) {
    lines.push('\nNo findings.');
  } else {
    lines.push('\n| Sev | Area | Location | Issue | Fix | Test to add |', '| --- | --- | --- | --- | --- | --- |');
    for (const f of findings) {
      const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
      lines.push(`| ${sev[f.severity] ?? f.severity} | ${cell(f.area)} | ${cell(f.location)} | ${cell(f.issue)} | ${cell(f.fix)} | ${cell(f.test)} |`);
    }
  }
  if (parsed.could_not_verify?.length) {
    lines.push('\n**Could not verify (static review limits):**');
    for (const c of parsed.could_not_verify) lines.push(`- ${c}`);
  }
  lines.push(foot);
  return lines.filter(Boolean).join('\n');
}

function renderReviewState(parsed, meta, diffPlan, previousReview) {
  const state = {
    version: 1,
    reviewerId: REVIEWER_ID,
    reviewMode: REVIEW_MODE,
    reviewProfile: REVIEW_PROFILE,
    verdict: parsed.verdict,
    summary: parsed.summary,
    findings: (parsed.findings ?? []).map((finding) => ({
      severity: finding.severity,
      area: finding.area,
      location: finding.location,
      issue: finding.issue,
      status: 'open',
    })),
    headRefName: meta.headRefName,
    baseRefName: meta.baseRefName,
    diffMode: diffPlan.mode,
    batches: diffPlan.batches.length,
    partial: diffPlan.partial,
    previousReviewSource: previousReview?.source,
    updatedAt: new Date().toISOString(),
  };
  return `${STATE_BEGIN}\n${JSON.stringify(state)}\n${STATE_END}`;
}

review().catch((err) => { console.error(err.message ?? err); process.exit(1); });
