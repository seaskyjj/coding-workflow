#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  mergeReviewResults,
  parsePositiveInteger,
  parseReviewStateFromComment,
  renderReviewState,
} from './ai-review.mjs';

const diffPlan = {
  mode: 'full-diff',
  fullDiffChars: 100,
  batches: [{ label: 'full PR diff', paths: [], chars: 100 }],
  omittedFiles: [],
  partial: false,
};

const stateParsed = {
  verdict: 'approve_after_fixes',
  summary: 'state can contain --> safely',
  findings: [{
    severity: 'med',
    area: 'E_reliability',
    location: 'scripts/ai-review.mjs:1',
    issue: 'diff text contains --> inside a finding',
  }],
};
const stateBlock = renderReviewState(
  stateParsed,
  { headRefName: 'head', baseRefName: 'base' },
  diffPlan,
  undefined,
);
assert.equal((stateBlock.match(/-->/g) ?? []).length, 1, 'state block must only contain the closing HTML comment marker');
const parsedState = parseReviewStateFromComment(stateBlock);
assert.equal(parsedState.findings[0].issue, stateParsed.findings[0].issue);
assert.equal(parsedState.findings[0].status, 'open');

const legacyState = { version: 1, verdict: 'approve', findings: [] };
const legacyBlock = `<!-- ai-review-state:default\n${JSON.stringify(legacyState)}\nai-review-state:end -->`;
assert.deepEqual(parseReviewStateFromComment(legacyBlock), legacyState, 'legacy raw-JSON review state remains readable');

assert.equal(parsePositiveInteger('', 12), 12);
assert.equal(parsePositiveInteger('abc', 12), 12);
assert.equal(parsePositiveInteger('0', 12), 12);
assert.equal(parsePositiveInteger('7', 12), 7);

const duplicateFinding = {
  severity: 'high',
  area: 'A_authz',
  location: 'server.ts:10',
  issue: 'same issue',
};
const deduped = mergeReviewResults([
  { batch: { label: 'batch 1' }, parsed: { verdict: 'request_changes', summary: 'one', findings: [duplicateFinding] } },
  { batch: { label: 'synthesis', synthesis: true }, parsed: { verdict: 'request_changes', summary: 'two', findings: [{ ...duplicateFinding }] } },
], diffPlan);
assert.equal(deduped.findings.length, 1, 'duplicate synthesis findings should not consume multiple finding slots');

const manyFindings = Array.from({ length: 13 }, (_, index) => ({
  severity: 'low',
  area: 'E_reliability',
  location: `file.ts:${index}`,
  issue: `issue ${index}`,
}));
const capped = mergeReviewResults([
  { batch: { label: 'batch 1' }, parsed: { verdict: 'approve_after_fixes', summary: 'many', findings: manyFindings } },
], diffPlan);
assert.equal(capped.findings.length, 12);
assert.ok(
  capped.could_not_verify.some((entry) => entry.includes('exceeded MAX_FINDINGS=12')),
  'runner-level finding truncation must be visible in could_not_verify',
);

console.log('ai-review self-tests passed.');
