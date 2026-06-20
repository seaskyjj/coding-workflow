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

const prReviewSkillPath = 'skills/coding-workflow-pr-review/SKILL.md';
const cicdDeploySkillPath = 'skills/coding-workflow-cicd-deploy/SKILL.md';
const prReviewSkill = readRequired(prReviewSkillPath);
const cicdDeploySkill = readRequired(cicdDeploySkillPath);
const readme = readRequired('README.md');

assertIncludes(prReviewSkill, 'name: coding-workflow-pr-review', prReviewSkillPath);
assertIncludes(prReviewSkill, 'WORKFLOW.md', prReviewSkillPath);
assertIncludes(prReviewSkill, 'BOOTSTRAP.md', prReviewSkillPath);
assertIncludes(prReviewSkill, 'ADOPT-PROMPT.md', prReviewSkillPath);
assertIncludes(prReviewSkill, 'reviewer/CHECKLIST.md', prReviewSkillPath);
assertIncludes(prReviewSkill, 'reviewer/PROPOSAL-CHECKLIST.md', prReviewSkillPath);
assertIncludes(prReviewSkill, 'templates/consumer-ci.yml', prReviewSkillPath);
assertIncludes(prReviewSkill, 'templates/consumer-ai-review.yml', prReviewSkillPath);
assertIncludes(prReviewSkill, 'scripts/ai-review.mjs', prReviewSkillPath);
assertIncludes(prReviewSkill, 'REVIEW_BACKEND', prReviewSkillPath);
assertIncludes(prReviewSkill, 'codex-cli', prReviewSkillPath);
assertIncludes(prReviewSkill, 'claude-cli', prReviewSkillPath);
assertIncludes(prReviewSkill, 'REVIEW_KIND', prReviewSkillPath);
assertIncludes(prReviewSkill, 'proposal', prReviewSkillPath);
assertIncludes(prReviewSkill, 'REVIEWER_OVERLAY', prReviewSkillPath);
assertIncludes(prReviewSkill, 'PR_LOG_PATH', prReviewSkillPath);
assertIncludes(prReviewSkill, 'needs_human', prReviewSkillPath);

assertIncludes(cicdDeploySkill, 'name: coding-workflow-cicd-deploy', cicdDeploySkillPath);
assertIncludes(cicdDeploySkill, 'service-manager plans', cicdDeploySkillPath);
assertIncludes(cicdDeploySkill, 'local-pr-gate.mjs', cicdDeploySkillPath);
assertIncludes(cicdDeploySkill, 'ci-diagnose-pr.mjs', cicdDeploySkillPath);
assertIncludes(cicdDeploySkill, 'deploy-remote-staging.mjs', cicdDeploySkillPath);
assertIncludes(cicdDeploySkill, 'self-hosted-runner-plan.mjs', cicdDeploySkillPath);
assertIncludes(cicdDeploySkill, 'consumer-local-gates.json', cicdDeploySkillPath);
assertIncludes(cicdDeploySkill, 'consumer-deploy-staging.json', cicdDeploySkillPath);

assertIncludes(readme, prReviewSkillPath, 'README.md');
assertIncludes(readme, cicdDeploySkillPath, 'README.md');
