#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildFilePatchDiffPlan,
  MAX_FINDINGS,
  MAX_DIFF_CHARS,
  assembleProposalDocContext,
  buildMissingPreviousReviewResult,
  defaultReviewerId,
  findReviewCommentInList,
  isProposalDocPath,
  localDiffPreflight,
  mergeReviewResults,
  normalizeBackend,
  normalizeStateKind,
  proposalDocContextBudget,
  renderProposalDocContext,
  parsePositiveInteger,
  parseReviewStateFromComment,
  renderReviewState,
  resolveCodexOutputSchema,
  resolveTrustedCommentAuthor,
  reviewStateMatchesKind,
  reviewStateMatchesReviewer,
  REVIEW_KIND,
  shouldRunSynthesis,
  shouldFailClosedWithoutPreviousReview,
} from './ai-review.mjs';

const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));

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
// The default test process runs as REVIEW_KIND=code, so rendered state must stamp that kind and a
// later same-kind run must accept it as previous context.
assert.equal(REVIEW_KIND, 'code', 'self-test process should default to the code review kind');
assert.equal(parsedState.kind, 'code', 'rendered review state must record its review kind');

// Review-kind isolation: a proposal run must not consume code-review state and vice versa; legacy
// state with no kind field is treated as code so it is not silently reused by a proposal review.
assert.equal(normalizeStateKind(undefined), 'code', 'missing kind defaults to code (legacy records)');
assert.equal(normalizeStateKind('proposal'), 'proposal');
assert.equal(normalizeStateKind('CODE'), 'code');
assert.equal(reviewStateMatchesKind({ kind: 'code' }, 'code'), true);
assert.equal(reviewStateMatchesKind({ kind: 'proposal' }, 'code'), false);
assert.equal(reviewStateMatchesKind({}, 'proposal'), false, 'legacy code state must not be reused as proposal context');
assert.equal(reviewStateMatchesKind({ kind: 'proposal' }, 'proposal'), true);

// Backend selection: accept the three known backends (case/space tolerant), reject anything else so a
// typo fails fast instead of silently degrading to the metered api backend.
assert.equal(normalizeBackend('api'), 'api');
assert.equal(normalizeBackend('claude-cli'), 'claude-cli');
assert.equal(normalizeBackend(' CODEX-CLI '), 'codex-cli');
assert.throws(() => normalizeBackend('codex'), /invalid REVIEW_BACKEND/, 'unknown backend must throw, not fall back to api');

// Per-backend comment-marker isolation: codex gets its own living comment so it never overwrites the
// claude/api review on the same PR; claude-cli/api keep the historical default/proposal markers.
assert.equal(defaultReviewerId('code', 'api'), 'default');
assert.equal(defaultReviewerId('code', 'claude-cli'), 'default');
assert.equal(defaultReviewerId('code', 'codex-cli'), 'codex');
assert.equal(defaultReviewerId('proposal', 'api'), 'proposal');
assert.equal(defaultReviewerId('proposal', 'codex-cli'), 'codex-proposal');

// --- Codex review findings on PR #4, encoded as regression tests ---------------------------------

// Finding 1 (B_contract): every backend normalizeBackend() accepts must be a legal pr_log review.backend,
// or a successful review appends a pr_log row that violates the schema.
const prLogSchema = readJson('./pr_log.schema.json');
const prLogBackendEnum = prLogSchema.properties.review.properties.backend.enum;
for (const backend of ['api', 'claude-cli', 'codex-cli']) {
  assert.ok(prLogBackendEnum.includes(backend), `pr_log.schema.json review.backend enum must include ${backend}`);
}

// Finding 2 (B_contract): the codex --output-schema area enum must stay in sync with the pr_log area enum,
// so a schema-valid Codex finding can never violate pr_log's stricter area enum when logged.
const reviewerOutputSchema = readJson('./reviewer-output.schema.json');
const reviewerAreaEnum = reviewerOutputSchema.properties.findings.items.properties.area.enum;
const prLogAreaEnum = prLogSchema.properties.review.properties.findings.items.properties.area.enum;
assert.ok(Array.isArray(reviewerAreaEnum), 'reviewer-output.schema.json must constrain findings[].area to an enum, not a free string');
assert.deepEqual([...reviewerAreaEnum].sort(), [...prLogAreaEnum].sort(), 'reviewer-output area enum must equal pr_log area enum');

// Finding 3 (E_reliability): an explicit CODEX_OUTPUT_SCHEMA path that does not exist is a typo, not a
// disable — it must fail fast, while the documented disable sentinels still return undefined.
assert.throws(() => resolveCodexOutputSchema('/definitely/missing-schema.json'), /CODEX_OUTPUT_SCHEMA=.*does not exist/, 'missing explicit schema path must throw, not silently disable schema output');
assert.equal(resolveCodexOutputSchema('0'), undefined, 'CODEX_OUTPUT_SCHEMA=0 disables schema-constrained output');
assert.equal(resolveCodexOutputSchema(''), undefined, 'empty CODEX_OUTPUT_SCHEMA disables schema-constrained output');
assert.equal(resolveCodexOutputSchema('none'), undefined, 'CODEX_OUTPUT_SCHEMA=none disables schema-constrained output');

// Finding 4 (E_reliability): pr_log state-fallback must be reviewer-scoped so a codex run never adopts a
// claude/api (or legacy, reviewerId-less) row as its own previous state, and vice versa.
assert.equal(reviewStateMatchesReviewer({ reviewerId: 'codex', kind: 'code' }, 'codex'), true);
assert.equal(reviewStateMatchesReviewer({ reviewerId: 'default', kind: 'code' }, 'codex'), false, 'a claude/api default row must not be reused as codex previous state');
assert.equal(reviewStateMatchesReviewer({ kind: 'code' }, 'codex'), false, 'a legacy row with no reviewerId must not be reused as codex previous state');
assert.equal(reviewStateMatchesReviewer({ kind: 'code' }, 'default'), true, 'a legacy code row maps to the default marker for backward compatibility');
assert.equal(reviewStateMatchesReviewer({ kind: 'proposal' }, 'proposal'), true, 'a legacy proposal row maps to the proposal marker');
assert.equal(reviewStateMatchesReviewer({ kind: 'proposal' }, 'codex-proposal'), false);

// --diff-file safety preflight: empty/oversized local diffs must fail closed WITHOUT a backend call.
assert.equal(localDiffPreflight('@@ small @@\n+ok', MAX_DIFF_CHARS), undefined, 'in-budget local diff is sent to the backend');
const emptyPreflight = localDiffPreflight('', MAX_DIFF_CHARS);
assert.equal(emptyPreflight.verdict, 'needs_human', 'empty local diff must not be approved');
assert.ok(emptyPreflight.could_not_verify.some((e) => e.includes('empty')), 'empty preflight must explain why');
const oversizedPreflight = localDiffPreflight('x'.repeat(MAX_DIFF_CHARS + 1), MAX_DIFF_CHARS);
assert.equal(oversizedPreflight.verdict, 'needs_human', 'oversized local diff must fail closed, not approve a truncated review');
assert.equal(oversizedPreflight.findings.length, 0);
assert.ok(
  oversizedPreflight.could_not_verify.some((e) => e.includes(`MAX_DIFF_CHARS=${MAX_DIFF_CHARS}`)),
  'oversized preflight must point at the cap that blocked the local review',
);

const legacyState = { version: 1, verdict: 'approve', findings: [] };
const legacyBlock = `<!-- ai-review-state:default\n${JSON.stringify(legacyState)}\nai-review-state:end -->`;
assert.deepEqual(parseReviewStateFromComment(legacyBlock), legacyState, 'legacy raw-JSON review state remains readable');

const forgedComment = { body: '<!-- ai-review:default --> forged', user: { login: 'attacker' } };
const trustedComment = { body: '<!-- ai-review:default --> trusted', user: { login: 'reviewer' } };
assert.equal(findReviewCommentInList([forgedComment, trustedComment], 'reviewer'), trustedComment);
assert.equal(findReviewCommentInList([forgedComment], 'reviewer'), undefined);
assert.equal(findReviewCommentInList([trustedComment], undefined), undefined);
assert.equal(resolveTrustedCommentAuthor({ explicit: 'configured', authenticatedLogin: 'ignored', isActions: true }), 'configured');
assert.equal(resolveTrustedCommentAuthor({ explicit: undefined, authenticatedLogin: 'local-user', isActions: true }), 'local-user');
assert.equal(resolveTrustedCommentAuthor({ explicit: undefined, authenticatedLogin: null, isActions: true }), 'github-actions[bot]');
assert.equal(resolveTrustedCommentAuthor({ explicit: undefined, authenticatedLogin: null, isActions: false }), undefined);

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

const mixedPatchPlan = buildFilePatchDiffPlan([
  { filename: 'src/reviewed.ts', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '@@ -1 +1 @@\n-old\n+new' },
  { filename: 'assets/no-patch.bin', status: 'modified', additions: 0, deletions: 0, changes: 0 },
], {
  mode: 'incremental-diff',
  repo: 'owner/repo',
  pr: 1,
  meta: { baseRefName: 'main', headRefOid: 'def456' },
  incremental: true,
  previousHeadSha: 'abc123',
  currentHeadSha: 'def456',
});
assert.deepEqual(mixedPatchPlan.batches[0].paths, ['src/reviewed.ts']);
assert.equal(mixedPatchPlan.omittedFiles[0].path, 'assets/no-patch.bin');
assert.equal(mixedPatchPlan.partial, true);

assert.equal(shouldFailClosedWithoutPreviousReview('deep', undefined), false);
assert.equal(shouldFailClosedWithoutPreviousReview('gate', undefined), true);
assert.equal(shouldFailClosedWithoutPreviousReview('confirm-fixes', undefined), true);
assert.equal(shouldFailClosedWithoutPreviousReview('gate', { verdict: 'approve_after_fixes', findings: [] }), true);
assert.equal(shouldFailClosedWithoutPreviousReview('gate', { verdict: 'needs_human', failedClosed: true, headSha: 'abc123' }), true);
assert.equal(
  shouldFailClosedWithoutPreviousReview('gate', { verdict: 'approve_after_fixes', findings: [], headSha: 'abc123' }),
  false,
);
const missingPrevious = buildMissingPreviousReviewResult('confirm-fixes');
assert.equal(missingPrevious.verdict, 'needs_human');
assert.equal(missingPrevious.failedClosed, true);
assert.ok(
  missingPrevious.could_not_verify.some((entry) => entry.includes('No previous review state with headSha')),
  'follow-up review without previous headSha state must explain why it needs a human',
);

// --- Proposal full-document context (F3 deferred enhancement) -------------------------------------

// Only markdown/text docs carry a full-document argument; code/binary files are reviewed from the diff.
for (const doc of ['docs/adr/0007.md', 'NOTES.mdx', 'plan.markdown', 'a/b.txt', 'design.rst', 'x.adoc']) {
  assert.equal(isProposalDocPath(doc), true, `${doc} should count as a proposal doc`);
}
for (const nonDoc of ['src/server.ts', 'image.png', 'data.json', 'Makefile', 'a.mdz']) {
  assert.equal(isProposalDocPath(nonDoc), false, `${nonDoc} should NOT count as a proposal doc`);
}

// Full docs within budget are included verbatim; nothing is flagged as omitted.
const fitCtx = assembleProposalDocContext(
  [{ path: 'docs/b.md', content: 'BBB' }, { path: 'docs/a.md', content: 'AAA' }],
  1000,
  'deadbeef1234',
);
assert.deepEqual(fitCtx.includedPaths, ['docs/b.md', 'docs/a.md'], 'assembly preserves caller order');
assert.ok(fitCtx.text.includes('### docs/a.md\nAAA') && fitCtx.text.includes('### docs/b.md\nBBB'));
assert.equal(fitCtx.omitted.length, 0);

// A doc over the whole budget is flagged (not silently truncated) so the prompt can fail closed for it,
// while a smaller later doc still fits — i.e. partial context is surfaced, never silently approved.
const overCtx = assembleProposalDocContext(
  [{ path: 'big.md', content: 'x'.repeat(50) }, { path: 'small.md', content: 'ok' }],
  20,
  'sha',
);
assert.deepEqual(overCtx.includedPaths, ['small.md']);
assert.equal(overCtx.omitted.length, 1);
assert.equal(overCtx.omitted[0].path, 'big.md');
assert.ok(overCtx.omitted[0].reason.includes('PROPOSAL_DOC_CONTEXT_CHARS=20'), 'omission must point at the cap that blocked it');

// Deleted / unfetchable docs are flagged as missing context, not dropped silently.
const missingDocCtx = assembleProposalDocContext(
  [{ path: 'gone.md', content: undefined, removed: true }, { path: 'binary.md', content: undefined }],
  1000,
  'sha9',
);
assert.equal(missingDocCtx.text, '');
assert.equal(missingDocCtx.omitted.length, 2);
assert.ok(missingDocCtx.omitted.find((o) => o.path === 'gone.md').reason.includes('deleted'));

// Rendered block tells the reviewer to reconstruct from full text AND to fail closed for omitted docs.
const rendered = renderProposalDocContext(overCtx, 'sha');
assert.ok(rendered.includes('FULL CHANGED-DOCUMENT CONTEXT'), 'must label the full-document context block');
assert.ok(rendered.includes('CHANGED DOCUMENTS NOT INCLUDED IN FULL') && rendered.includes('fail closed'), 'must surface omitted docs as fail-closed context');
// Code review (no fullDocContext) must be entirely unaffected.
assert.equal(renderProposalDocContext(undefined, 'sha'), '');

// --- Codex review findings on PR #5, encoded as regression tests ---------------------------------

// Finding 1 (C_policy): omitted changed docs are a RUNNER-enforced fail-closed condition — a model
// returning approve must still be forced to needs_human, with the omitted doc surfaced.
const omittedDocPlan = {
  ...diffPlan,
  partial: false,
  omittedFiles: [],
  omittedDocs: [{ path: 'docs/adr/0009-big.md', reason: 'full document is 999999 chars, above PROPOSAL_DOC_CONTEXT_CHARS=120000' }],
};
const forcedByDocOmission = mergeReviewResults(
  [{ batch: { label: 'proposal' }, parsed: { verdict: 'approve', summary: 'looks fine', findings: [] } }],
  omittedDocPlan,
);
assert.equal(forcedByDocOmission.verdict, 'needs_human', 'an omitted changed doc must force needs_human even if the backend returned approve');
assert.ok(
  forcedByDocOmission.could_not_verify.some((entry) => entry.includes('docs/adr/0009-big.md')),
  'the omitted doc must be named in could_not_verify',
);

// Finding 2 (B_contract): full-doc context shares the diff budget — a near-cap batch diff shrinks the
// doc budget so the composed (diff + docs) prompt stays within MAX_DIFF_CHARS, never cap-on-top-of-cap.
assert.equal(proposalDocContextBudget(0, 120000, 200000), 120000, 'a tiny diff leaves the full doc cap available');
assert.equal(proposalDocContextBudget(190000, 120000, 200000), 10000, 'a near-cap diff shrinks the doc budget to the remaining room');
assert.equal(proposalDocContextBudget(200000, 120000, 200000), 0, 'a diff at the cap leaves no room for docs (they get flagged -> needs_human)');
for (const batch of [0, 50000, 199000, 250000]) {
  assert.ok(proposalDocContextBudget(batch, 120000, 200000) + Math.min(batch, 200000) <= 200000, `composed diff+docs budget must stay within MAX_DIFF_CHARS (batch=${batch})`);
}

console.log('ai-review self-tests passed.');
