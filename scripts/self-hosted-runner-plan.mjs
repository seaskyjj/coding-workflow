#!/usr/bin/env node
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import {
  fail,
  markdownTable,
  nowIso,
  outputDirDefault,
  parseArgs,
  readJsonFile,
  redact,
  writeJsonFile,
} from './cicd-lib.mjs';

function splitList(value) {
  return String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

function hostedUnavailableCount(diagnostics) {
  const checks = diagnostics.checks ?? [];
  const runs = diagnostics.runHistory ?? [];
  return [...checks, ...runs].filter((item) => item.classification === 'hosted_runner_unavailable').length;
}

function localCoverageGaps(localGate) {
  const gaps = [];
  if (!localGate) return ['local gate evidence missing'];
  if (localGate.status !== 'passed') gaps.push(`local gate status is ${localGate.status}`);
  for (const [name, coverage] of Object.entries(localGate.hostedCoverage ?? {})) {
    if (coverage.status !== 'passed') gaps.push(`${name}: ${coverage.status}`);
  }
  return gaps;
}

export function buildSelfHostedRunnerPlan({ diagnostics, localGate, note, targetHost, runnerLabels, repoScope }) {
  const count = hostedUnavailableCount(diagnostics);
  const gaps = localCoverageGaps(localGate);
  const missingInputs = [];
  if (!targetHost) missingInputs.push('target host');
  if (!repoScope) missingInputs.push('repo scope');
  if (runnerLabels.length === 0) missingInputs.push('runner labels');

  let status = 'not_eligible';
  const reasons = [];
  if (count < 2) reasons.push('repeated hosted-runner unavailability evidence not present (requires at least two classified records)');
  if (!note) reasons.push('local CI insufficiency note missing');
  if (count >= 2 && note && missingInputs.length > 0) {
    status = 'needs_input';
    reasons.push(`missing plan inputs: ${missingInputs.join(', ')}`);
  } else if (count >= 2 && note) {
    status = 'eligible';
  }

  return {
    schemaVersion: 1,
    kind: 'self-hosted-runner-plan',
    generatedAt: nowIso(),
    status,
    hostedRunnerUnavailableRecords: count,
    localGateStatus: localGate?.status ?? 'missing',
    localCoverageGaps: gaps,
    localCiInsufficientNote: note || null,
    targetHost: targetHost || null,
    runnerLabels,
    repoScope: repoScope || null,
    reasons,
    tokenHandling: 'not implemented by this tool; do not write GitHub runner tokens to disk',
    registration: 'not implemented by this tool; human/operator registration required',
    prerequisites: status === 'eligible' ? [
      'Human selects repository or organization runner scope in GitHub.',
      'Human creates an ephemeral registration token in GitHub and uses it interactively on the target host.',
      'Operator verifies the host patching, secret storage, workspace cleanup, and service account model.',
      'Operator verifies local gate gaps that remain after runner setup.',
    ] : [],
    commandPlan: status === 'eligible' ? [
      {
        step: 'inspect-host',
        command: `ssh ${targetHost} 'uname -a && id && df -h .'`,
      },
      {
        step: 'prepare-workspace',
        command: `ssh ${targetHost} 'mkdir -p ~/actions-runner && cd ~/actions-runner'`,
      },
      {
        step: 'register-runner',
        command: 'Use GitHub-provided runner registration commands interactively. Do not paste or save tokens into this plan.',
      },
      {
        step: 'verify-labels',
        command: `Confirm runner labels include: ${runnerLabels.join(', ')}`,
      },
    ] : [],
  };
}

export function renderSelfHostedRunnerMarkdown(plan) {
  return `# Self-Hosted Runner Plan

- status: ${plan.status}
- hostedRunnerUnavailableRecords: ${plan.hostedRunnerUnavailableRecords}
- localGateStatus: ${plan.localGateStatus}
- targetHost: ${plan.targetHost ?? 'not provided'}
- repoScope: ${plan.repoScope ?? 'not provided'}
- runnerLabels: ${plan.runnerLabels.length ? plan.runnerLabels.join(', ') : 'not provided'}

## Reasons

${plan.reasons.length ? plan.reasons.map((item) => `- ${item}`).join('\n') : '- eligible evidence supplied'}

## Local Coverage Gaps

${plan.localCoverageGaps.length ? plan.localCoverageGaps.map((item) => `- ${item}`).join('\n') : '- none recorded'}

## Command Plan

${plan.commandPlan.length ? markdownTable(['step', 'command'], plan.commandPlan.map((item) => [item.step, item.command])) : 'No registration commands generated because the plan is not eligible or still needs input.'}

## Boundaries

- runner token handling: ${plan.tokenHandling}
- registration: ${plan.registration}
- implemented: evidence-gated plan generation
- not implemented: automatic runner registration, token storage, production secret provisioning
`;
}

async function main() {
  const args = parseArgs();
  if (args['--help']) {
    console.log('Usage: node scripts/self-hosted-runner-plan.mjs --diagnostics-json file --local-gate-json file --local-ci-insufficient-note "..." --target-host host --runner-labels labels --repo-scope owner/repo');
    return;
  }
  if (!args['--diagnostics-json']) fail('need --diagnostics-json file');
  if (!args['--local-gate-json']) fail('need --local-gate-json file');
  const outputDir = path.resolve(args['--output-dir'] ?? outputDirDefault('self-hosted-runner-plan'));
  try {
    const plan = buildSelfHostedRunnerPlan({
      diagnostics: readJsonFile(args['--diagnostics-json']),
      localGate: readJsonFile(args['--local-gate-json']),
      note: args['--local-ci-insufficient-note'],
      targetHost: args['--target-host'],
      runnerLabels: splitList(args['--runner-labels']),
      repoScope: args['--repo-scope'],
    });
    const jsonPath = path.join(outputDir, 'self-hosted-runner-plan.json');
    const mdPath = path.join(outputDir, 'self-hosted-runner-plan.md');
    writeJsonFile(jsonPath, plan);
    writeFileSync(mdPath, renderSelfHostedRunnerMarkdown(plan), 'utf8');
    if (args['--json']) {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      console.log(redact(`self-hosted runner plan ${plan.status}; evidence: ${mdPath}`));
    }
    process.exit(plan.status === 'eligible' || plan.status === 'not_eligible' ? 0 : 1);
  } catch (error) {
    fail(redact(error.message), 2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
