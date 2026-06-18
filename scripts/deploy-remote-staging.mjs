#!/usr/bin/env node
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import {
  appendJsonl,
  ensureDir,
  fail,
  markdownTable,
  nowIso,
  parseArgs,
  readJsonFile,
  redact,
  repoRootFrom,
  shQuote,
  writeJsonFile,
} from './cicd-lib.mjs';
import { buildServiceManagerPlan } from './service-manager-plan.mjs';

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function assertNoSecretUrl(value, name) {
  const parsed = new URL(value);
  if (parsed.username || parsed.password || parsed.search) {
    throw new Error(`${name} must not include userinfo or query string; pass signed URLs/secrets through target-host env or a product smoke command`);
  }
}

export function resolveDeployTarget(config, targetName, overrides = {}) {
  if (!config || config.schemaVersion !== 1 || typeof config.targets !== 'object') {
    throw new Error('deploy config must be schemaVersion=1 with a targets object');
  }
  const target = config.targets[targetName];
  if (!target) throw new Error(`target ${targetName} not found in deploy config`);
  const merged = { ...target };
  if (overrides.installCommand) merged.installCommand = overrides.installCommand;
  if (overrides.npmCi) merged.installCommand = 'npm ci';
  if (merged.productionRelease === true) {
    throw new Error('deploy-remote-staging refuses productionRelease=true; production promotion needs a separate explicit workflow');
  }
  for (const field of ['host', 'repoRoot', 'manager', 'buildCommand', 'healthUrl']) {
    if (!merged[field]) throw new Error(`target ${targetName} missing required field ${field}`);
  }
  if (!Array.isArray(merged.services)) throw new Error(`target ${targetName} services must be an array`);
  merged.healthAttempts = positiveInteger(Number(merged.healthAttempts), 'healthAttempts');
  merged.healthIntervalSeconds = positiveInteger(Number(merged.healthIntervalSeconds), 'healthIntervalSeconds');
  merged.logExcerptLines = positiveInteger(Number(merged.logExcerptLines), 'logExcerptLines');
  if (merged.sshConnectTimeoutSeconds != null) {
    merged.sshConnectTimeoutSeconds = positiveInteger(Number(merged.sshConnectTimeoutSeconds), 'sshConnectTimeoutSeconds');
  }
  if (merged.executionTimeoutSeconds != null) {
    merged.executionTimeoutSeconds = positiveInteger(Number(merged.executionTimeoutSeconds), 'executionTimeoutSeconds');
  }
  if (merged.sshBatchMode != null && typeof merged.sshBatchMode !== 'boolean') {
    throw new Error('sshBatchMode must be a boolean when provided');
  }
  assertNoSecretUrl(merged.healthUrl, 'healthUrl');
  return merged;
}

export function buildSshArgv(target) {
  const args = [];
  if (target.sshBatchMode === true) args.push('-o', 'BatchMode=yes');
  if (target.sshConnectTimeoutSeconds != null) {
    args.push('-o', `ConnectTimeout=${target.sshConnectTimeoutSeconds}`);
  }
  args.push(target.host, 'bash -s');
  return ['ssh', ...args];
}

function runBlock(label, command) {
  return [
    `run_cmd ${shQuote(label)} ${shQuote(command)}`,
  ].join('\n');
}

export function buildRemoteDeployScript({ target, ref, allowDirty }) {
  const servicePlan = buildServiceManagerPlan({
    manager: target.manager,
    services: target.services,
    composeFile: target.composeFile,
  });
  const statusBefore = servicePlan.commands.filter((cmd) => cmd.phase === 'status-before');
  const restart = servicePlan.commands.filter((cmd) => cmd.phase === 'restart');
  const statusAfter = servicePlan.commands.filter((cmd) => cmd.phase === 'status-after');
  const recentLogs = servicePlan.commands.filter((cmd) => cmd.phase === 'recent-logs');
  const logPaths = target.logPaths ?? [];

  const lines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `CW_REQUESTED_REF=${shQuote(ref)}`,
    `CW_REPO_ROOT=${shQuote(target.repoRoot)}`,
    `CW_HEALTH_URL=${shQuote(target.healthUrl)}`,
    `CW_HEALTH_ATTEMPTS=${Number(target.healthAttempts)}`,
    `CW_HEALTH_INTERVAL_SECONDS=${Number(target.healthIntervalSeconds)}`,
    `CW_LOG_EXCERPT_LINES=${Number(target.logExcerptLines)}`,
    'redact_stream() {',
    "  sed -E 's/([Aa]uthorization[[:space:]]*[:=][[:space:]]*)([Bb]earer|[Bb]asic)?[[:space:]]*[^[:space:]\"'\"',;]+/\\1<redacted>/g' | \\",
    "  sed -E 's/([A-Za-z0-9_./-]*(TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|SIGNATURE|CREDENTIAL)[A-Za-z0-9_./-]*[[:space:]]*[:=][[:space:]]*)[^[:space:]\"'\"',;]+/\\1<redacted>/Ig' | \\",
    "  sed -E 's/([?&](token|secret|password|passwd|api[_-]?key|access[_-]?key|signature|sig|x-amz-signature|credential|expires)=)[^&[:space:]]+/\\1<redacted>/Ig'",
    '}',
    'run_cmd() {',
    '  local label="$1"',
    '  local command="$2"',
    '  echo "::coding-workflow::phase=${label}"',
    '  set +e',
    '  local output',
    '  output="$(eval "$command" 2>&1)"',
    '  local code=$?',
    '  set -e',
    '  printf "%s\\n" "$output" | redact_stream',
    '  if [ "$code" -ne 0 ]; then',
    '    echo "::coding-workflow::phase_failed=${label};exit=${code}"',
    '    return "$code"',
    '  fi',
    '}',
    'resolve_ref() {',
    '  if git rev-parse --verify --quiet "${CW_REQUESTED_REF}^{commit}" >/dev/null; then',
    '    git rev-parse "${CW_REQUESTED_REF}^{commit}"',
    '  elif git rev-parse --verify --quiet "origin/${CW_REQUESTED_REF}^{commit}" >/dev/null; then',
    '    git rev-parse "origin/${CW_REQUESTED_REF}^{commit}"',
    '  else',
    '    echo "::coding-workflow::ref_not_found=${CW_REQUESTED_REF}"',
    '    exit 21',
    '  fi',
    '}',
    'cd "$CW_REPO_ROOT"',
    'CW_HEALTH_OUT="$(mktemp)"',
    'CW_HEALTH_ERR="$(mktemp)"',
    'chmod 600 "$CW_HEALTH_OUT" "$CW_HEALTH_ERR"',
    'trap \'rm -f "$CW_HEALTH_OUT" "$CW_HEALTH_ERR"\' EXIT',
    'beforeHead="$(git rev-parse HEAD)"',
    'echo "__CODING_WORKFLOW_DEPLOY_FIELD__beforeHead=${beforeHead}"',
    allowDirty
      ? 'echo "::coding-workflow::dirty_worktree_allowed=true"'
      : 'if [ -n "$(git status --porcelain)" ]; then echo "::coding-workflow::dirty_worktree=true"; exit 20; fi',
    runBlock('git-fetch', 'git fetch --all --tags'),
    'resolvedRef="$(resolve_ref)"',
    runBlock('git-checkout', 'git checkout --detach "$resolvedRef"'),
    'deployedHead="$(git rev-parse HEAD)"',
    'echo "__CODING_WORKFLOW_DEPLOY_FIELD__deployedHead=${deployedHead}"',
    ...statusBefore.map((cmd) => runBlock(cmd.phase, cmd.command)),
  ];

  if (target.installCommand) lines.push(runBlock('dependency-install', target.installCommand));
  lines.push(runBlock('build', target.buildCommand));
  if (target.migrationCommand) lines.push(runBlock('migration', target.migrationCommand));
  lines.push(...restart.map((cmd) => runBlock(cmd.phase, cmd.command)));
  lines.push(...statusAfter.map((cmd) => runBlock(cmd.phase, cmd.command)));
  lines.push(
    'health_status=failed',
    'for attempt in $(seq 1 "$CW_HEALTH_ATTEMPTS"); do',
    '  if curl -fsS "$CW_HEALTH_URL" >"$CW_HEALTH_OUT" 2>"$CW_HEALTH_ERR"; then',
    '    health_status=passed',
    '    break',
    '  fi',
    '  if [ "$attempt" -lt "$CW_HEALTH_ATTEMPTS" ]; then sleep "$CW_HEALTH_INTERVAL_SECONDS"; fi',
    'done',
    'echo "__CODING_WORKFLOW_DEPLOY_FIELD__health=${health_status}"',
    'if [ "$health_status" != "passed" ]; then',
    '  cat "$CW_HEALTH_ERR" 2>/dev/null | redact_stream',
    '  exit 30',
    'fi',
  );
  if (target.smokeCommand) {
    lines.push(runBlock('smoke', target.smokeCommand), 'echo "__CODING_WORKFLOW_DEPLOY_FIELD__smoke=provided"');
  } else {
    lines.push('echo "__CODING_WORKFLOW_DEPLOY_FIELD__smoke=not_provided"');
  }
  if (recentLogs.length > 0 || logPaths.length > 0) {
    lines.push('echo "::coding-workflow::recent_logs"');
    lines.push(...recentLogs.map((cmd) => `${runBlock(cmd.phase, `${cmd.command} || true`)}`));
    for (const logPath of logPaths) {
      lines.push(runBlock('configured-log', `if [ -f ${shQuote(logPath)} ]; then tail -n "$CW_LOG_EXCERPT_LINES" ${shQuote(logPath)}; else echo ${shQuote(`log path not found: ${logPath}`)}; fi`));
    }
  }
  lines.push(
    'rollbackRef="${beforeHead}"',
    'echo "__CODING_WORKFLOW_DEPLOY_FIELD__rollbackRef=${rollbackRef}"',
    'echo "::coding-workflow::deploy_complete"',
  );
  return { script: `${lines.join('\n')}\n`, servicePlan };
}

function parseDeployFields(output) {
  const fields = {};
  for (const line of output.split('\n')) {
    const match = line.match(/^__CODING_WORKFLOW_DEPLOY_FIELD__([^=]+)=(.*)$/);
    if (match) fields[match[1]] = match[2];
  }
  return fields;
}

function executeSsh({ sshArgv, script, executionTimeoutSeconds }) {
  return new Promise((resolve) => {
    const child = spawn(sshArgv[0], sshArgv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = executionTimeoutSeconds == null ? null : setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, executionTimeoutSeconds * 1000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: timedOut ? 124 : code,
        signal,
        timedOut,
        stdout: redact(stdout),
        stderr: redact(timedOut ? `${stderr}\nexecution timed out after ${executionTimeoutSeconds}s` : stderr),
      });
    });
    child.stdin.end(script);
  });
}

export async function deployRemoteStaging(options) {
  const repoRoot = repoRootFrom(options.repoRoot ?? process.cwd());
  const config = readJsonFile(path.resolve(repoRoot, options.config));
  const target = resolveDeployTarget(config, options.target, options);
  const defaultOutputDir = path.join('tmp', 'coding-workflow', 'deploy', `${options.target}-${Date.now()}`);
  const outputDir = path.resolve(repoRoot, options.outputDir ?? defaultOutputDir);
  ensureDir(outputDir);
  const { script, servicePlan } = buildRemoteDeployScript({ target, ref: options.ref, allowDirty: options.allowDirty });
  const sshArgv = buildSshArgv(target);
  const scriptPath = path.join(outputDir, 'remote-staging-deploy.sh');
  writeFileSync(scriptPath, script, 'utf8');
  chmodSync(scriptPath, 0o700);

  const basePlan = {
    schemaVersion: 1,
    kind: 'remote-staging-deploy',
    generatedAt: nowIso(),
    target: options.target,
    host: target.host,
    repoRoot: target.repoRoot,
    requestedRef: options.ref,
    productionRelease: false,
    allowDirty: Boolean(options.allowDirty),
    mode: options.execute ? 'execute' : 'dry-run',
    sshArgv,
    executionTimeoutSeconds: target.executionTimeoutSeconds ?? null,
    scriptPath,
    auditTrailPath: target.auditTrailPath ?? path.join(outputDir, 'deploy-history.jsonl'),
    healthUrl: redact(target.healthUrl),
    smoke: target.smokeCommand ? 'provided' : 'not_provided',
    servicePlan,
  };
  writeJsonFile(path.join(outputDir, 'deploy-plan.json'), basePlan);
  writeFileSync(path.join(outputDir, 'deploy-summary.md'), renderDeployMarkdown(basePlan), 'utf8');

  if (!options.execute) {
    return { status: 'dry-run', plan: basePlan, outputDir };
  }

  const result = await executeSsh({ sshArgv, script, executionTimeoutSeconds: target.executionTimeoutSeconds });
  writeFileSync(path.join(outputDir, 'remote-stdout.log'), result.stdout, 'utf8');
  writeFileSync(path.join(outputDir, 'remote-stderr.log'), result.stderr, 'utf8');
  const fields = parseDeployFields(`${result.stdout}\n${result.stderr}`);
  const record = {
    completedAt: nowIso(),
    deploymentKind: 'scripted_staging',
    status: result.code === 0 ? 'passed' : 'failed',
    productionRelease: false,
    target: options.target,
    host: target.host,
    requestedRef: options.ref,
    beforeHead: fields.beforeHead ?? null,
    deployedHead: fields.deployedHead ?? null,
    rollbackRef: fields.rollbackRef ?? fields.beforeHead ?? null,
    healthUrl: redact(target.healthUrl),
    health: fields.health ?? 'not_verified',
    smoke: fields.smoke ?? (target.smokeCommand ? 'provided' : 'not_provided'),
    outputDir,
    auditTrailPath: basePlan.auditTrailPath,
    timedOut: result.timedOut,
    error: result.code === 0 ? null : redact(result.stderr || result.stdout || `ssh exited ${result.code}`),
  };
  appendJsonl(path.resolve(repoRoot, basePlan.auditTrailPath), record);
  writeJsonFile(path.join(outputDir, 'deploy-result.json'), record);
  return { status: record.status, plan: basePlan, result: record, outputDir };
}

export function renderDeployMarkdown(plan) {
  return `# Remote Staging Deploy Plan

- target: ${plan.target}
- host: ${plan.host}
- requestedRef: ${plan.requestedRef}
- productionRelease: false
- mode: ${plan.mode}
- script: ${plan.scriptPath}
- auditTrailPath: ${plan.auditTrailPath}
- healthUrl: ${plan.healthUrl}

## SSH

\`${plan.sshArgv.join(' ')}\`

## Service Manager

${markdownTable(['phase', 'command'], plan.servicePlan.commands.map((cmd) => [cmd.phase, cmd.command]))}

## Boundaries

- implemented: staging deploy script generation${plan.mode === 'execute' ? ' and SSH execution' : ''}
- not implemented: production release, automatic rollback, runner registration, secret storage
- rollback: evidence and command template only; no automatic rollback is performed
`;
}

async function main() {
  const args = parseArgs();
  if (args['--help']) {
    console.log('Usage: node scripts/deploy-remote-staging.mjs --config .coding-workflow/deploy.staging.json --target NAME --ref REF (--dry-run | --execute) [--npm-ci]');
    return;
  }
  if (!args['--config']) fail('need --config path');
  if (!args['--target']) fail('need --target NAME');
  if (!args['--ref']) fail('need --ref REF');
  if (Boolean(args['--dry-run']) === Boolean(args['--execute'])) fail('choose exactly one of --dry-run or --execute');
  try {
    const result = await deployRemoteStaging({
      config: args['--config'],
      target: args['--target'],
      ref: args['--ref'],
      dryRun: Boolean(args['--dry-run']),
      execute: Boolean(args['--execute']),
      npmCi: Boolean(args['--npm-ci']),
      installCommand: args['--install-command'],
      allowDirty: Boolean(args['--allow-dirty']),
      outputDir: args['--output-dir'],
      repoRoot: args['--repo-root'],
    });
    console.log(redact(`remote staging deploy ${result.status}; evidence: ${result.outputDir}`));
    if (result.status === 'failed') process.exit(1);
  } catch (error) {
    fail(redact(error.message), 2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
