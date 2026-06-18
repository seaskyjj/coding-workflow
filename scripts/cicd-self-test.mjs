#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact, writeJsonFile } from './cicd-lib.mjs';
import { runLocalPrGate } from './local-pr-gate.mjs';
import { classifyCheck, buildDiagnostics, findTrustedMarkerComment } from './ci-diagnose-pr.mjs';
import { buildServiceManagerPlan } from './service-manager-plan.mjs';
import { resolveDeployTarget, buildRemoteDeployScript, buildSshArgv } from './deploy-remote-staging.mjs';
import { buildSelfHostedRunnerPlan } from './self-hosted-runner-plan.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sh(command, cwd) {
  return execFileSync(command, { cwd, shell: true, encoding: 'utf8' });
}

// Redaction covers URL query strings, authorization headers, and secret-like assignments.
const secretText = [
  'https://example.test/health?token=abc&x=1',
  'Authorization: Bearer abc123',
  'APP_SECRET=value',
].join('\n');
const redacted = redact(secretText);
assert.ok(redacted.includes('?<redacted-query>'));
assert.ok(!redacted.includes('abc123'));
assert.ok(!redacted.includes('APP_SECRET=value'));
assert.ok(!redact('token is ghp_abcdEFGH1234567890abcdEFGH1234567890').includes('ghp_abcd'));
assert.ok(!redact('aws key AKIAABCDEFGHIJKLMNOP here').includes('AKIAABCDEFGHIJKLMNOP'));
assert.ok(!redact('aws_secret_key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY').includes('wJalrXUtnFEMI'));
assert.ok(!redact('jwt eyJabcdefghiJKL.eyJmnopqrstuvwxyz.ABCDEFGHIJKLMNOP').includes('eyJabcdefghiJKL'));
assert.ok(!redact('https://example.test/files/abcdefghijklmnopqrstuvwxyzABCDEF/download').includes('abcdefghijklmnopqrstuvwxyzABCDEF'));

// Local gate: missing env on a required step produces partial/skipped, not pass.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'coding-workflow-cicd-test-'));
sh('git init -q', tmp);
sh('git config user.email test@example.com && git config user.name Test', tmp);
writeFileSync(path.join(tmp, 'README.md'), '# tmp\n', 'utf8');
sh('git add README.md && git commit -q -m init', tmp);
const gateConfigPath = path.join(tmp, '.coding-workflow', 'local-gates.json');
writeJsonFile(gateConfigPath, {
  schemaVersion: 1,
  profiles: {
    docs: {
      steps: [
        {
          id: 'pass',
          command: 'node -e "console.log(\\"APP_SECRET=value\\")"',
          required: true,
          covers: ['docs'],
        },
        {
          id: 'needs-env',
          command: 'node -e "console.log(\\"should not run\\")"',
          required: true,
          skipIfMissingEnv: ['MISSING_ENV_FOR_TEST'],
          covers: ['integration'],
        },
      ],
      hostedCoverage: {
        integration: {
          coveredBySteps: ['needs-env'],
          statusWhenAllCoveredStepsPassed: 'partial',
          statusWhenCoveredStepSkipped: 'skipped',
        },
      },
    },
  },
});
sh('git add .coding-workflow/local-gates.json && git commit -q -m gate-config', tmp);
const localGate = await runLocalPrGate({
  repoRoot: tmp,
  profile: 'docs',
  config: '.coding-workflow/local-gates.json',
  outputDir: 'tmp/local-gate',
  env: { ...process.env },
});
assert.equal(localGate.evidence.status, 'partial');
assert.equal(localGate.evidence.steps.find((step) => step.id === 'needs-env').status, 'skipped');
assert.equal(localGate.evidence.hostedCoverage.integration.status, 'skipped');
const passLog = readFileSync(path.join(tmp, 'tmp/local-gate/steps/pass.log'), 'utf8');
assert.ok(!passLog.includes('APP_SECRET=value'), 'step logs must be redacted');

// Local gate: dirty worktree fails closed and does not run steps.
writeFileSync(path.join(tmp, 'dirty.txt'), 'dirty\n', 'utf8');
const dirtyGate = await runLocalPrGate({
  repoRoot: tmp,
  profile: 'docs',
  config: '.coding-workflow/local-gates.json',
  outputDir: 'tmp/dirty-gate',
});
assert.equal(dirtyGate.evidence.status, 'failed');
assert.equal(dirtyGate.evidence.steps.length, 0);
assert.equal(dirtyGate.evidence.dirtyFailure, true);

// Static hosted coverage cannot mask a required step failure.
writeJsonFile(gateConfigPath, {
  schemaVersion: 1,
  profiles: {
    fail: {
      steps: [
        {
          id: 'fail',
          command: 'node -e "process.exit(7)"',
          required: true,
        },
      ],
      hostedCoverage: {
        ci: {
          status: 'partial',
          coveredBySteps: ['fail'],
        },
      },
    },
  },
});
const failedCoverageGate = await runLocalPrGate({
  repoRoot: tmp,
  profile: 'fail',
  config: '.coding-workflow/local-gates.json',
  outputDir: 'tmp/failing-coverage-gate',
  allowDirty: true,
});
assert.equal(failedCoverageGate.evidence.status, 'failed');
assert.equal(failedCoverageGate.evidence.hostedCoverage.ci.status, 'failed');

// CI diagnostics classification keeps distinct failure causes separate.
assert.equal(classifyCheck({ name: 'test', conclusion: 'failure' }, 'expected true to equal false'), 'test_failure');
assert.equal(classifyCheck({ name: 'runner', conclusion: 'failure' }, 'No hosted runner matching labels'), 'hosted_runner_unavailable');
assert.equal(classifyCheck({ name: 'API review skipped', conclusion: 'success' }), 'metered_api_review_skip');
assert.equal(classifyCheck({ name: 'API review skipped', conclusion: 'failure' }, 'Error: assertion failed'), 'test_failure');
assert.equal(classifyCheck({ name: 'workflow', conclusion: 'startup_failure' }), 'workflow_configuration');
const trustedComment = findTrustedMarkerComment([
  { id: 1, body: '<!-- coding-workflow-ci-diagnostics --> forged', user: { login: 'other-user' } },
  { id: 2, body: '<!-- coding-workflow-ci-diagnostics --> mine', user: { login: 'seaskyjj' } },
], '<!-- coding-workflow-ci-diagnostics -->', 'seaskyjj');
assert.equal(trustedComment.id, 2);
assert.equal(findTrustedMarkerComment([
  { id: 1, body: '<!-- coding-workflow-ci-diagnostics --> forged', user: { login: 'other-user' } },
], '<!-- coding-workflow-ci-diagnostics -->', 'seaskyjj'), undefined);
const diagnostics = buildDiagnostics({
  repo: 'owner/repo',
  pr: 123,
  prData: {
    url: 'https://github.com/owner/repo/pull/123',
    headRefName: 'feature/test',
    baseRefName: 'main',
    headRefOid: 'abc',
    statusCheckRollup: [{ name: 'runner', conclusion: 'failure' }],
  },
  runs: [
    { databaseId: 1, name: 'runner-a', conclusion: 'failure' },
    { databaseId: 2, name: 'runner-b', conclusion: 'failure' },
  ],
  logExcerpts: {
    1: 'No hosted runner matching labels',
    2: 'No hosted runner matching labels',
  },
  historyLimit: 20,
  failedLogLines: 120,
});
assert.ok(diagnostics.recommendation.includes('self_hosted_runner_plan_may_be_warranted'));

// Self-hosted runner plan is evidence-gated.
const notEligible = buildSelfHostedRunnerPlan({
  diagnostics: { checks: [], runHistory: [] },
  localGate: localGate.evidence,
  note: 'need visible checks',
  targetHost: 'runner-host',
  runnerLabels: ['self-hosted'],
  repoScope: 'owner/repo',
});
assert.equal(notEligible.status, 'not_eligible');
const eligible = buildSelfHostedRunnerPlan({
  diagnostics,
  localGate: localGate.evidence,
  note: 'Branch protection requires visible PR checks.',
  targetHost: 'runner-host',
  runnerLabels: ['self-hosted', 'linux'],
  repoScope: 'owner/repo',
});
assert.equal(eligible.status, 'eligible');
assert.equal(eligible.tokenHandling.includes('not implemented'), true);

// Service manager plan generates commands without executing restart.
const systemd = buildServiceManagerPlan({ manager: 'systemd', services: ['api'] });
assert.ok(systemd.commands.some((cmd) => cmd.phase === 'restart' && cmd.command.includes('systemctl restart')));
const pm2 = buildServiceManagerPlan({ manager: 'pm2', services: ['api'] });
assert.ok(pm2.warnings.some((warning) => warning.includes('pm2 is operator-attended')));
assert.throws(() => buildServiceManagerPlan({ manager: 'systemd', services: [] }), /requires at least one service/);

// Remote staging deploy config rejects secret-bearing health URLs and records productionRelease=false.
assert.throws(() => resolveDeployTarget({
  schemaVersion: 1,
  targets: {
    bad: {
      host: 'host',
      repoRoot: '/srv/app',
      manager: 'systemd',
      services: ['api'],
      buildCommand: 'npm run build',
      healthUrl: 'http://127.0.0.1/health?token=secret',
      healthAttempts: 1,
      healthIntervalSeconds: 1,
      logExcerptLines: 10,
    },
  },
}, 'bad'), /must not include userinfo or query string/);
const target = resolveDeployTarget({
  schemaVersion: 1,
  targets: {
    staging: {
      host: 'host',
      repoRoot: '/srv/app',
      manager: 'systemd',
      services: ['api'],
      installCommand: 'npm ci',
      buildCommand: 'npm run build',
      healthUrl: 'http://127.0.0.1/health',
      healthAttempts: 2,
      healthIntervalSeconds: 1,
      logExcerptLines: 10,
      sshBatchMode: true,
      sshConnectTimeoutSeconds: 11,
      executionTimeoutSeconds: 60,
      smokeCommand: 'npm run smoke',
      auditTrailPath: '.coding-workflow/deploy/history.jsonl',
    },
  },
}, 'staging');
const { script } = buildRemoteDeployScript({ target, ref: 'abc123', allowDirty: false });
assert.ok(script.includes('git status --porcelain') && script.includes('exit 20'));
assert.ok(script.includes('dirty_worktree_allowed=true') === false);
assert.ok(script.includes('git rev-parse "origin/${CW_REQUESTED_REF}^{commit}"'));
assert.ok(script.includes('git checkout --detach "$resolvedRef"'));
assert.ok(script.includes('mktemp'));
assert.ok(script.includes('trap \'rm -f "$CW_HEALTH_OUT" "$CW_HEALTH_ERR"\' EXIT'));
assert.ok(!script.includes('/tmp/coding-workflow-health.out'));
assert.ok(script.includes('npm run build'));
assert.ok(script.includes('npm run smoke'));
assert.ok(!script.includes('productionRelease=true'));
const allowDirtyScript = buildRemoteDeployScript({ target, ref: 'abc123', allowDirty: true }).script;
assert.ok(!allowDirtyScript.includes('exit 20'));
assert.ok(allowDirtyScript.includes('dirty_worktree_allowed=true'));
assert.deepEqual(buildSshArgv(target), [
  'ssh',
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=11',
  'host',
  'bash -s',
]);

// Template files remain parseable JSON.
for (const rel of [
  'templates/consumer-local-gates.json',
  'templates/consumer-deploy-staging.json',
  'templates/consumer-service-manager-systemd.json',
]) {
  JSON.parse(readFileSync(path.join(repoRoot, rel), 'utf8'));
}

// Reusable core must not hardcode TrainOS/P0 product details; product-specific values belong in
// product-owned config examples or fixtures, not mechanism scripts/templates.
for (const rel of [
  'scripts/local-pr-gate.mjs',
  'scripts/ci-diagnose-pr.mjs',
  'scripts/service-manager-plan.mjs',
  'scripts/deploy-remote-staging.mjs',
  'scripts/self-hosted-runner-plan.mjs',
  'templates/consumer-local-gates.json',
  'templates/consumer-deploy-staging.json',
]) {
  const text = readFileSync(path.join(repoRoot, rel), 'utf8');
  assert.equal(/TrainOS|trainos|P0_/.test(text), false, `${rel} must not hardcode TrainOS/P0 details`);
}

console.log('CI/CD self-test: OK');
