#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readRequired(relPath) {
  const fullPath = path.join(repoRoot, relPath);
  assert.equal(existsSync(fullPath), true, `${relPath} must exist`);
  return readFileSync(fullPath, 'utf8');
}

function assertIncludes(text, needle, relPath) {
  assert.ok(text.includes(needle), `${relPath} must include ${needle}`);
}

function assertFileExists(relPath) {
  const fullPath = path.join(repoRoot, relPath);
  assert.equal(existsSync(fullPath), true, `${relPath} must exist`);
}

function assertDocumentedFile(text, relPath, skillPath) {
  assertIncludes(text, relPath, skillPath);
  assertFileExists(relPath);
}

function assertDocumentedInterface(skillText, implementationText, token, skillPath, implementationPath) {
  assertIncludes(skillText, token, skillPath);
  assertIncludes(implementationText, token, implementationPath);
}

const prReviewSkillPath = 'skills/coding-workflow-pr-review/SKILL.md';
const cicdDeploySkillPath = 'skills/coding-workflow-cicd-deploy/SKILL.md';
const aiReviewPath = 'scripts/ai-review.mjs';
const reviewerOutputSchemaPath = 'scripts/reviewer-output.schema.json';
const prReviewSkill = readRequired(prReviewSkillPath);
const cicdDeploySkill = readRequired(cicdDeploySkillPath);
const aiReview = readRequired(aiReviewPath);
const reviewerOutputSchema = readRequired(reviewerOutputSchemaPath);
const readme = readRequired('README.md');

assertIncludes(prReviewSkill, 'name: coding-workflow-pr-review', prReviewSkillPath);
for (const relPath of [
  'WORKFLOW.md',
  'BOOTSTRAP.md',
  'ADOPT-PROMPT.md',
  'reviewer/CHECKLIST.md',
  'reviewer/PROPOSAL-CHECKLIST.md',
  'templates/consumer-ci.yml',
  'templates/consumer-ai-review.yml',
  aiReviewPath,
]) {
  assertDocumentedFile(prReviewSkill, relPath, prReviewSkillPath);
}
for (const token of [
  'REVIEW_BACKEND',
  '--backend',
  'codex-cli',
  'claude-cli',
  'REVIEW_KIND',
  '--review-kind',
  'REVIEWER_OVERLAY',
  'PR_LOG_PATH',
]) {
  assertDocumentedInterface(prReviewSkill, aiReview, token, prReviewSkillPath, aiReviewPath);
}
assertIncludes(prReviewSkill, 'REVIEW_KIND="${REVIEW_KIND:-code}"', prReviewSkillPath);
assertIncludes(prReviewSkill, '- Use `proposal`', prReviewSkillPath);
assertIncludes(aiReview, "['code', 'proposal']", aiReviewPath);
assertIncludes(prReviewSkill, 'fail closed with `needs_human`', prReviewSkillPath);
assertIncludes(reviewerOutputSchema, '"needs_human"', reviewerOutputSchemaPath);

assertIncludes(cicdDeploySkill, 'name: coding-workflow-cicd-deploy', cicdDeploySkillPath);
assertIncludes(cicdDeploySkill, 'service-manager plans', cicdDeploySkillPath);
for (const relPath of [
  'templates/consumer-local-gates.json',
  'templates/consumer-deploy-staging.json',
  'scripts/local-pr-gate.mjs',
  'scripts/ci-diagnose-pr.mjs',
  'scripts/deploy-remote-staging.mjs',
  'scripts/self-hosted-runner-plan.mjs',
]) {
  assertDocumentedFile(cicdDeploySkill, relPath, cicdDeploySkillPath);
}
assertFileExists('scripts/service-manager-plan.mjs');
assertFileExists('templates/consumer-self-hosted-runner-plan.md');

assertIncludes(readme, prReviewSkillPath, 'README.md');
assertIncludes(readme, cicdDeploySkillPath, 'README.md');
