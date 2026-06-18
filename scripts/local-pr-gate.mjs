#!/usr/bin/env node
import path from 'node:path';
import {
  ensureDir,
  fail,
  gitInfo,
  hostFacts,
  markdownTable,
  nowIso,
  parseArgs,
  readJsonFile,
  redact,
  repoRootFrom,
  runShellCommand,
  sanitizeId,
  writeJsonFile,
} from './cicd-lib.mjs';
import { writeFileSync } from 'node:fs';

export function validateGateConfig(config) {
  if (!config || config.schemaVersion !== 1 || typeof config.profiles !== 'object') {
    throw new Error('local gate config must be schemaVersion=1 with a profiles object');
  }
  for (const [profileId, profile] of Object.entries(config.profiles)) {
    if (!Array.isArray(profile.steps) || profile.steps.length === 0) {
      throw new Error(`profile ${profileId} must define at least one step`);
    }
    const ids = new Set();
    for (const step of profile.steps) {
      if (!step.id || typeof step.command !== 'string' || step.command.trim() === '') {
        throw new Error(`profile ${profileId} has a step without id or command`);
      }
      if (ids.has(step.id)) throw new Error(`profile ${profileId} repeats step id ${step.id}`);
      ids.add(step.id);
      if (step.skipIfMissingEnv && !Array.isArray(step.skipIfMissingEnv)) {
        throw new Error(`step ${step.id} skipIfMissingEnv must be an array`);
      }
    }
  }
}

function missingEnvFor(step, env) {
  return (step.skipIfMissingEnv ?? []).filter((name) => !env[name]);
}

function deriveHostedCoverage(profile, stepResults) {
  const byId = new Map(stepResults.map((step) => [step.id, step]));
  const coverage = {};
  for (const [name, rule] of Object.entries(profile.hostedCoverage ?? {})) {
    if (rule.status) {
      coverage[name] = { status: rule.status, note: rule.note ?? null };
      continue;
    }
    const ids = rule.coveredBySteps ?? stepResults.map((step) => step.id);
    const covered = ids.map((id) => byId.get(id)).filter(Boolean);
    let status = 'partial';
    if (covered.length === 0) {
      status = 'skipped';
    } else if (covered.some((step) => step.status === 'failed')) {
      status = 'failed';
    } else if (covered.some((step) => step.status === 'skipped')) {
      status = rule.statusWhenCoveredStepSkipped ?? 'partial';
    } else if (covered.every((step) => step.status === 'passed')) {
      status = rule.statusWhenAllCoveredStepsPassed ?? 'partial';
    }
    coverage[name] = {
      status,
      note: rule.note ?? null,
      coveredBySteps: ids,
    };
  }
  return coverage;
}

function summarizeGateStatus({ dirtyFailure, stepResults }) {
  if (dirtyFailure) return 'failed';
  if (stepResults.some((step) => step.required && step.status === 'failed')) return 'failed';
  if (stepResults.some((step) => step.status === 'failed')) return 'partial';
  if (stepResults.some((step) => step.status === 'skipped')) return 'partial';
  return 'passed';
}

export async function runLocalPrGate(options) {
  const repoRoot = repoRootFrom(options.repoRoot ?? process.cwd());
  const configPath = path.resolve(repoRoot, options.config);
  const config = readJsonFile(configPath);
  validateGateConfig(config);
  const profile = config.profiles[options.profile];
  if (!profile) {
    throw new Error(`profile ${options.profile} not found in ${configPath}`);
  }

  const defaultOutputDir = path.join('tmp', 'coding-workflow', 'local-pr-gate', sanitizeId(options.profile));
  const outputDir = path.resolve(repoRoot, options.outputDir ?? defaultOutputDir);
  const logsDir = path.join(outputDir, 'steps');
  ensureDir(logsDir);

  const git = gitInfo(repoRoot);
  const dirtyFailure = git.isGitRepo && git.dirtyFiles.length > 0 && !options.allowDirty;
  const stepResults = [];

  if (!dirtyFailure) {
    for (const step of profile.steps) {
      const missingEnv = missingEnvFor(step, options.env ?? process.env);
      const required = step.required !== false;
      const logPath = path.join(logsDir, `${sanitizeId(step.id)}.log`);
      if (missingEnv.length > 0) {
        const reason = `missing env: ${missingEnv.join(', ')}`;
        writeFileSync(logPath, `${reason}\n`, 'utf8');
        stepResults.push({
          id: step.id,
          required,
          status: 'skipped',
          skipReason: reason,
          missingEnv,
          covers: step.covers ?? [],
          logPath,
        });
        continue;
      }
      const result = await runShellCommand(step.command, { cwd: repoRoot, env: options.env ?? process.env });
      writeFileSync(logPath, [
        `$ ${redact(step.command)}`,
        '',
        '[stdout]',
        result.stdout,
        '',
        '[stderr]',
        result.stderr,
      ].join('\n'), 'utf8');
      stepResults.push({
        id: step.id,
        required,
        command: redact(step.command),
        status: result.exitCode === 0 ? 'passed' : 'failed',
        exitCode: result.exitCode,
        signal: result.signal,
        durationMs: result.durationMs,
        covers: step.covers ?? [],
        logPath,
      });
    }
  }

  const status = summarizeGateStatus({ dirtyFailure, stepResults });
  const evidence = {
    schemaVersion: 1,
    kind: 'local-pr-gate',
    status,
    generatedAt: nowIso(),
    profile: options.profile,
    description: profile.description ?? null,
    repoRoot,
    configPath,
    outputDir,
    allowDirty: Boolean(options.allowDirty),
    git,
    host: hostFacts(),
    dirtyFailure,
    steps: stepResults,
    hostedCoverage: deriveHostedCoverage(profile, stepResults),
    honesty: {
      claim: status === 'passed'
        ? 'implemented: local gate profile passed on this host'
        : status === 'partial'
          ? 'partial: local evidence is incomplete or optional coverage failed/skipped'
          : 'failed: local gate did not pass',
      hostedCiReplacement: false,
    },
  };

  const jsonPath = path.join(outputDir, 'local-pr-gate.json');
  const mdPath = path.join(outputDir, 'local-pr-gate.md');
  writeJsonFile(jsonPath, evidence);
  writeFileSync(mdPath, renderLocalGateMarkdown(evidence), 'utf8');
  return { evidence, jsonPath, mdPath };
}

export function renderLocalGateMarkdown(evidence) {
  const rows = evidence.steps.map((step) => [
    step.id,
    step.required ? 'yes' : 'no',
    step.status,
    step.skipReason ?? (step.exitCode == null ? '' : `exit ${step.exitCode}`),
    path.relative(evidence.outputDir, step.logPath),
  ]);
  const coverageRows = Object.entries(evidence.hostedCoverage).map(([name, item]) => [
    name,
    item.status,
    item.note ?? '',
  ]);
  return `# Local PR Gate Evidence

- status: ${evidence.status}
- profile: ${evidence.profile}
- generatedAt: ${evidence.generatedAt}
- headSha: ${evidence.git.headSha ?? 'not available'}
- dirty worktree: ${evidence.git.dirtyFiles.length > 0 ? 'yes' : 'no'}
- hosted CI replacement: no

## Steps

${markdownTable(['step', 'required', 'status', 'detail', 'log'], rows.length ? rows : [['not run', '', evidence.status, evidence.dirtyFailure ? 'dirty worktree failed closed' : '', '']])}

## Hosted Coverage

${coverageRows.length ? markdownTable(['hosted check', 'local coverage status', 'note'], coverageRows) : 'No hosted coverage mapping declared.'}

## Honesty

${evidence.honesty.claim}
`;
}

async function main() {
  const args = parseArgs();
  if (args['--help']) {
    console.log('Usage: node scripts/local-pr-gate.mjs --profile ID --config .coding-workflow/local-gates.json [--output-dir DIR] [--allow-dirty] [--json]');
    return;
  }
  if (!args['--profile']) fail('need --profile ID');
  if (!args['--config']) fail('need --config path');
  try {
    const { evidence, mdPath } = await runLocalPrGate({
      profile: args['--profile'],
      config: args['--config'],
      outputDir: args['--output-dir'],
      allowDirty: Boolean(args['--allow-dirty']),
      repoRoot: args['--repo-root'],
    });
    if (args['--json']) {
      console.log(JSON.stringify(evidence, null, 2));
    } else {
      console.log(redact(`local PR gate ${evidence.status}; evidence: ${mdPath}`));
    }
    process.exit(evidence.status === 'passed' ? 0 : 1);
  } catch (error) {
    fail(redact(error.message), 2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
