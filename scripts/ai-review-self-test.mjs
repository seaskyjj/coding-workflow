#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  MAX_FINDINGS,
  buildMissingPreviousReviewResult,
  mergeReviewResults,
  parsePositiveInteger,
  parseReviewStateFromComment,
  renderReviewState,
  shouldRunSynthesis,
  shouldFailClosedWithoutPreviousReview,
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
  { headRefName: 'head', baseRefName: 'base', headRefOid: 'abc1234567890' },
  diffPlan,
  undefined,
);
assert.equal((stateBlock.match(/-->/g) ?? []).length, 1, 'state block must only contain the closing HTML comment marker');
const parsedState = parseReviewStateFromComment(stateBlock);
assert.equal(parsedState.findings[0].issue, stateParsed.findings[0].issue);
assert.equal(parsedState.findings[0].status, 'open');
assert.equal(parsedState.headSha, 'abc1234567890');
assert.equal(parsedState.currentHead, 'abc1234567890');

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

const manyFindings = Array.from({ length: MAX_FINDINGS + 1 }, (_, index) => ({
  severity: 'low',
  area: 'E_reliability',
  location: `file.ts:${index}`,
  issue: `issue ${index}`,
}));
const capped = mergeReviewResults([
  { batch: { label: 'batch 1' }, parsed: { verdict: 'approve_after_fixes', summary: 'many', findings: manyFindings } },
], diffPlan);
assert.equal(capped.findings.length, MAX_FINDINGS);
assert.ok(
  capped.could_not_verify.some((entry) => entry.includes(`exceeded MAX_FINDINGS=${MAX_FINDINGS}`)),
  'runner-level finding truncation must be visible in could_not_verify',
);

const overCapSynthesisPlan = {
  ...diffPlan,
  mode: 'file-batches',
  batches: [{ label: 'batch 1' }, { label: 'batch 2' }],
  criticalPatches: [{ path: 'server.ts', priority: 0, chars: Number.MAX_SAFE_INTEGER, diff: 'too large' }],
};
assert.equal(
  shouldRunSynthesis(overCapSynthesisPlan, [{ parsed: { verdict: 'approve', findings: [] } }]),
  false,
  'synthesis should not run when every critical patch exceeds the synthesis patch cap',
);

assert.equal(shouldFailClosedWithoutPreviousReview('deep', undefined), false);
assert.equal(shouldFailClosedWithoutPreviousReview('gate', undefined), true);
assert.equal(shouldFailClosedWithoutPreviousReview('confirm-fixes', undefined), true);
assert.equal(shouldFailClosedWithoutPreviousReview('gate', { verdict: 'approve_after_fixes', findings: [] }), true);
assert.equal(
  shouldFailClosedWithoutPreviousReview('gate', { verdict: 'approve_after_fixes', findings: [], headSha: 'abc123' }),
  false,
);
const missingPrevious = buildMissingPreviousReviewResult('confirm-fixes');
assert.equal(missingPrevious.verdict, 'needs_human');
assert.ok(
  missingPrevious.could_not_verify.some((entry) => entry.includes('No previous review state with headSha')),
  'follow-up review without previous headSha state must explain why it needs a human',
);

console.log('ai-review self-tests passed.');
