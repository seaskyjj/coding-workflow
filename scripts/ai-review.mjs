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
//   MAX_DIFF_CHARS      default 200000  (if exceeded -> verdict forced to needs_human)
// Args: --repo owner/name --pr N [--backend api|claude-cli] [--overlay path]
//
// Requires `gh` authenticated (GITHUB_TOKEN/GH_TOKEN in Actions).

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { buildPrRecord, appendRecord } from './pr-log.mjs';

const API_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5';
const CLI_MODEL = process.env.CLAUDE_CLI_MODEL; // optional; else CLI default
const MAX_DIFF_CHARS = Number(process.env.MAX_DIFF_CHARS ?? 200000);
const PR_LOG_PATH = process.env.PR_LOG_PATH ?? 'pr_log.jsonl';
const MARKER = '<!-- ai-review -->';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function gh(args, opts = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}
function readSibling(rel) {
  return readFileSync(new URL(rel, import.meta.url), 'utf8');
}
function resolveOverlay() {
  const explicit = arg('--overlay') ?? process.env.REVIEWER_OVERLAY;
  if (explicit) return existsSync(explicit) ? readFileSync(explicit, 'utf8') : undefined;
  for (const p of ['.coding-workflow/reviewer-overlay.md', 'reviewer-overlay.md']) {
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
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
    gh(['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${existing.id}`, '-f', `body=${body}`]);
  } else {
    gh(['api', '-X', 'POST', `repos/${repo}/issues/${pr}/comments`, '-f', `body=${body}`]);
  }
}

async function review() {
  const repo = arg('--repo') ?? process.env.GITHUB_REPOSITORY;
  const pr = arg('--pr') ?? process.env.PR_NUMBER;
  const backend = arg('--backend') ?? process.env.REVIEW_BACKEND ?? 'api';
  if (!repo || !pr) throw new Error('need --repo owner/name and --pr N (or GITHUB_REPOSITORY/PR_NUMBER)');

  const meta = JSON.parse(gh(['pr', 'view', String(pr), '--repo', repo, '--json', 'title,body']));
  let diff = gh(['pr', 'diff', String(pr), '--repo', repo]);
  let truncated = false;
  if (diff.length > MAX_DIFF_CHARS) {
    diff = diff.slice(0, MAX_DIFF_CHARS);
    truncated = true;
  }

  let systemText = readSibling('../reviewer/CHECKLIST.md');
  const overlay = resolveOverlay();
  if (overlay) systemText += `\n\n# Project overlay (repo-specific rules — apply in addition to the above)\n\n${overlay}`;

  const promptTemplate = readSibling('../reviewer/review-prompt.md');
  const userText =
    `${promptTemplate}\n\n---\nPR TITLE: ${meta.title}\n\nPR BODY:\n${meta.body ?? '(none)'}\n\n` +
    `DIFF${truncated ? ' (TRUNCATED — incomplete)' : ''}:\n\n${diff}`;

  const text = backend === 'claude-cli' ? callClaudeCli(systemText, userText) : await callApi(systemText, userText);

  let parsed = parseReview(text);
  // Truncation is a blocker: a partial diff must not yield an approval (#4).
  if (truncated && parsed) {
    parsed.verdict = 'needs_human';
    parsed.could_not_verify = [
      `diff exceeded MAX_DIFF_CHARS (${MAX_DIFF_CHARS}); review covers only the first part — a human must review the full diff`,
      ...(parsed.could_not_verify ?? []),
    ];
  }

  const comment = renderComment(parsed, text, truncated, overlay != null, backend);
  upsertComment(repo, pr, comment);

  const record = buildPrRecord(repo, pr);
  record.review = parsed
    ? { verdict: parsed.verdict, summary: parsed.summary, rounds: 1, backend, overlay: overlay != null,
        findings: (parsed.findings ?? []).map((f) => ({ severity: f.severity, area: f.area, location: f.location, issue: f.issue, turned_into_test: null, status: 'open' })) }
    : { verdict: 'needs_human', summary: 'review output not machine-parseable', rounds: 1, backend, overlay: overlay != null, findings: [] };
  appendRecord(PR_LOG_PATH, record);

  const verdict = parsed?.verdict ?? 'needs_human';
  console.error(`[${backend}] verdict: ${verdict} (${parsed?.findings?.length ?? '?'} findings)${truncated ? ' [TRUNCATED→needs_human]' : ''} -> ${repo}#${pr}`);
  if (process.env.REVIEW_FAIL_ON && verdict === process.env.REVIEW_FAIL_ON) process.exit(1);
}

function parseReview(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  try { return JSON.parse(candidate); } catch { return undefined; }
}

function renderComment(parsed, rawText, truncated, hasOverlay, backend) {
  const foot = `\n\n---\n_Advisory (${backend}${hasOverlay ? ' + project overlay' : ''}). The non-AI CI gate is the safety net. Each real-bug finding should become a regression test in this PR._`;
  if (!parsed) {
    return `${MARKER}\n## 🤖 AI review — needs human (unparseable output)\n${truncated ? '> ⚠️ diff was truncated\n\n' : ''}\n${rawText}${foot}`;
  }
  const sev = { high: '🔴', med: '🟡', low: '⚪' };
  const lines = [
    MARKER,
    `## 🤖 AI review — verdict: \`${parsed.verdict}\``,
    parsed.summary ? `\n${parsed.summary}\n` : '',
    truncated ? '> ⚠️ diff exceeded the size cap — review is **partial**, forced to `needs_human`. A human must review the full diff.\n' : '',
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
