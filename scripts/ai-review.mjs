#!/usr/bin/env node
// ai-review.mjs — self-contained AI PR reviewer.
// Reads a PR diff, reviews it through reviewer/CHECKLIST.md via the Anthropic API,
// posts a structured review comment, and appends a pr_log record.
//
// Env:
//   ANTHROPIC_API_KEY   (required)
//   ANTHROPIC_MODEL     (default below; set to your preferred model id)
//   GITHUB_REPOSITORY   owner/name (auto-set in GitHub Actions) or pass --repo
//   PR_LOG_PATH         default pr_log.jsonl
//   REVIEW_FAIL_ON      "request_changes" to make CI fail on that verdict (default: never fail)
//   MAX_DIFF_CHARS      default 200000
// Args: --repo owner/name --pr N   (fall back to env)
//
// Requires `gh` authenticated (GITHUB_TOKEN in Actions).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { buildPrRecord, appendRecord } from './pr-log.mjs';

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5';
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

async function review() {
  const repo = arg('--repo') ?? process.env.GITHUB_REPOSITORY;
  const pr = arg('--pr') ?? process.env.PR_NUMBER;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!repo || !pr) throw new Error('need --repo owner/name and --pr N (or GITHUB_REPOSITORY/PR_NUMBER)');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required');

  const meta = JSON.parse(gh(['pr', 'view', String(pr), '--repo', repo, '--json', 'title,body']));
  let diff = gh(['pr', 'diff', String(pr), '--repo', repo]);
  let truncated = false;
  if (diff.length > MAX_DIFF_CHARS) {
    diff = diff.slice(0, MAX_DIFF_CHARS);
    truncated = true;
  }

  const checklist = readSibling('../reviewer/CHECKLIST.md');
  const promptTemplate = readSibling('../reviewer/review-prompt.md');
  const userContent =
    `${promptTemplate}\n\n---\nPR TITLE: ${meta.title}\n\nPR BODY:\n${meta.body ?? '(none)'}\n\n` +
    `DIFF${truncated ? ' (TRUNCATED — review what is shown, note the truncation)' : ''}:\n\n${diff}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      system: [{ type: 'text', text: checklist, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');

  const parsed = parseReview(text);
  const comment = renderComment(parsed, text, truncated);
  gh(['pr', 'comment', String(pr), '--repo', repo, '--body-file', '-'], { input: comment });

  // pr_log: GitHub-derived base record + this review.
  const record = buildPrRecord(repo, pr);
  record.review = parsed
    ? { verdict: parsed.verdict, summary: parsed.summary, rounds: 1, findings: (parsed.findings ?? []).map((f) => ({
        severity: f.severity, area: f.area, location: f.location, issue: f.issue,
        turned_into_test: null, status: 'open',
      })) }
    : { verdict: 'needs_human', summary: 'review output not machine-parseable', rounds: 1, findings: [] };
  appendRecord(PR_LOG_PATH, record);

  const verdict = parsed?.verdict ?? 'needs_human';
  console.error(`review verdict: ${verdict} (${parsed?.findings?.length ?? '?'} findings) -> commented on ${repo}#${pr}`);
  if (process.env.REVIEW_FAIL_ON && verdict === process.env.REVIEW_FAIL_ON) process.exit(1);
}

function parseReview(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

function renderComment(parsed, rawText, truncated) {
  if (!parsed) {
    return `${MARKER}\n## 🤖 AI review (unparseable — needs human)\n${truncated ? '> diff was truncated\n\n' : ''}\n${rawText}`;
  }
  const sev = { high: '🔴', med: '🟡', low: '⚪' };
  const lines = [
    MARKER,
    `## 🤖 AI review — verdict: \`${parsed.verdict}\``,
    parsed.summary ? `\n${parsed.summary}\n` : '',
    truncated ? '> ⚠️ diff was truncated; review covers the shown portion only.\n' : '',
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
  lines.push('\n---\n_Advisory. The non-AI CI gate (typecheck/test/lint/eval) is the safety net. Each real-bug finding should become a regression test in this PR._');
  return lines.filter(Boolean).join('\n');
}

review().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
