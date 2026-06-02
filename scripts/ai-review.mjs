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
//   MAX_DIFF_CHARS      default 200000  (large PRs are reviewed as file batches under this cap)
//   MAX_FINDINGS        default 12      (merged finding cap across all batches)
// Args: --repo owner/name --pr N [--backend api|claude-cli] [--overlay path] [--print-diff-plan]
//
// Requires `gh` authenticated (GITHUB_TOKEN/GH_TOKEN in Actions).

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { buildPrRecord, appendRecord } from './pr-log.mjs';

const API_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5';
const CLI_MODEL = process.env.CLAUDE_CLI_MODEL; // optional; else CLI default
const MAX_DIFF_CHARS = Number(process.env.MAX_DIFF_CHARS ?? 200000);
const MAX_FINDINGS = Number(process.env.MAX_FINDINGS ?? 12);
const PR_LOG_PATH = process.env.PR_LOG_PATH ?? 'pr_log.jsonl';
// reviewer-scoped marker so multiple AI reviewers (claude / codex) don't overwrite each other's comment.
const REVIEWER_ID = process.env.REVIEW_COMMENT_ID ?? process.env.REVIEWER_ID ?? 'default';
const MARKER = `<!-- ai-review:${REVIEWER_ID} -->`;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasArg(name) {
  return process.argv.includes(name);
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
function upsertComment(repo, pr, body) {
  const comments = JSON.parse(gh(['api', `repos/${repo}/issues/${pr}/comments`, '--paginate']));
  const existing = comments.find((c) => typeof c.body === 'string' && c.body.includes(MARKER));
  if (existing) {
    ghJson('PATCH', `repos/${repo}/issues/comments/${existing.id}`, { body });
  } else {
    ghJson('POST', `repos/${repo}/issues/${pr}/comments`, { body });
  }
}

async function review() {
  const repo = arg('--repo') ?? process.env.GITHUB_REPOSITORY;
  const pr = arg('--pr') ?? process.env.PR_NUMBER;
  const backend = arg('--backend') ?? process.env.REVIEW_BACKEND ?? 'api';
  if (!repo || !pr) throw new Error('need --repo owner/name and --pr N (or GITHUB_REPOSITORY/PR_NUMBER)');

  const meta = JSON.parse(gh(['pr', 'view', String(pr), '--repo', repo, '--json', 'title,body,baseRefName,headRefName']));
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
    const userText = buildReviewUserText(promptTemplate, meta, batch, diffPlan);
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

  const comment = renderComment(parsed, reviewResults.map((r) => r.rawText).join('\n\n--- batch output ---\n\n'), diffPlan, overlay != null, backend);
  upsertComment(repo, pr, comment);

  const record = buildPrRecord(repo, pr);
  record.review = parsed
    ? { verdict: parsed.verdict, summary: parsed.summary, rounds: reviewResults.length, backend, overlay: overlay != null,
        findings: (parsed.findings ?? []).map((f) => ({ severity: f.severity, area: f.area, location: f.location, issue: f.issue, turned_into_test: null, status: 'open' })) }
    : { verdict: 'needs_human', summary: 'review output not machine-parseable', rounds: 1, backend, overlay: overlay != null, findings: [] };
  appendRecord(PR_LOG_PATH, record);

  const verdict = parsed?.verdict ?? 'needs_human';
  console.error(`[${backend}] verdict: ${verdict} (${parsed?.findings?.length ?? '?'} findings)${diffPlan.mode === 'file-batches' ? ` [${diffPlan.batches.length} file batch(es)]` : ''}${diffPlan.partial ? ' [PARTIAL→needs_human]' : ''} -> ${repo}#${pr}`);
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
      omittedFiles: [],
      partial: false,
    };
  }

  const files = JSON.parse(gh(['api', `repos/${repo}/pulls/${pr}/files`, '--paginate']));
  const batches = [];
  const omittedFiles = [];
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
    omittedFiles,
    partial: omittedFiles.length > 0,
  };
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

function buildReviewUserText(promptTemplate, meta, batch, diffPlan) {
  const batchNote = diffPlan.mode === 'file-batches'
    ? `\n\nDIFF MODE: file-batched review because full PR diff is ${diffPlan.fullDiffChars} chars, above MAX_DIFF_CHARS=${MAX_DIFF_CHARS}.\nBATCH: ${batch.label}\nFILES IN THIS BATCH:\n${batch.paths.map((p) => `- ${p}`).join('\n') || '(none)'}\n`
    : '';
  return `${promptTemplate}\n\n---\nPR TITLE: ${meta.title}\n\nPR BODY:\n${meta.body ?? '(none)'}${batchNote}\n\nDIFF:\n\n${batch.diff}`;
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
  return {
    verdict,
    summary: `${summaryPrefix}${summaries.join(' / ') || 'Review completed.'}`,
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
    partial: diffPlan.partial,
    batches: diffPlan.batches.map((batch) => ({
      label: batch.label,
      chars: batch.chars,
      files: batch.paths,
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

function renderComment(parsed, rawText, diffPlan, hasOverlay, backend) {
  const foot = `\n\n---\n_Advisory (${backend}${hasOverlay ? ' + project overlay' : ''}). The non-AI CI gate is the safety net. Each real-bug finding should become a regression test in this PR._`;
  if (!parsed) {
    return `${MARKER}\n## 🤖 AI review — needs human (unparseable output)\n${diffPlan.partial ? '> ⚠️ diff review was partial\n\n' : ''}\n${rawText}${foot}`;
  }
  const sev = { high: '🔴', med: '🟡', low: '⚪' };
  const lines = [
    MARKER,
    `## 🤖 AI review — verdict: \`${parsed.verdict}\``,
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

review().catch((err) => { console.error(err.message ?? err); process.exit(1); });
