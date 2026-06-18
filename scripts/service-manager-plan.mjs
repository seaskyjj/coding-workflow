#!/usr/bin/env node
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import {
  fail,
  markdownTable,
  nowIso,
  parseArgs,
  readJsonFile,
  redact,
  shQuote,
  writeJsonFile,
} from './cicd-lib.mjs';

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}

export function buildServiceManagerPlan({ manager, services, composeFile }) {
  const ids = asArray(services);
  const warnings = [];
  const commands = [];
  if (!manager) throw new Error('service manager is required');
  if (manager !== 'none' && ids.length === 0) throw new Error(`manager ${manager} requires at least one service id`);

  if (manager === 'systemd') {
    for (const service of ids) {
      const unit = shQuote(service);
      commands.push(
        { phase: 'status-before', command: `sudo systemctl status ${unit} --no-pager` },
        { phase: 'restart', command: `sudo systemctl restart ${unit}` },
        { phase: 'status-after', command: `sudo systemctl status ${unit} --no-pager` },
        { phase: 'recent-logs', command: `sudo journalctl -u ${unit} -n "$CW_LOG_EXCERPT_LINES" --no-pager` },
        { phase: 'stop', command: `sudo systemctl stop ${unit}` },
      );
    }
    return { manager, services: ids, persistenceClaim: 'systemd unit persistence depends on the product host unit configuration', warnings, commands };
  }

  if (manager === 'pm2') {
    warnings.push('pm2 is operator-attended unless pm2 startup persistence has been explicitly verified on the target host.');
    for (const service of ids) {
      const app = shQuote(service);
      commands.push(
        { phase: 'status-before', command: `pm2 describe ${app}` },
        { phase: 'restart', command: `pm2 restart ${app}` },
        { phase: 'status-after', command: `pm2 describe ${app}` },
        { phase: 'recent-logs', command: `pm2 logs ${app} --lines "$CW_LOG_EXCERPT_LINES" --nostream` },
        { phase: 'stop', command: `pm2 stop ${app}` },
      );
    }
    return { manager, services: ids, persistenceClaim: 'not verified by this tool', warnings, commands };
  }

  if (manager === 'docker-compose') {
    const compose = composeFile ? ` -f ${shQuote(composeFile)}` : '';
    const serviceArgs = ids.map(shQuote).join(' ');
    warnings.push('docker-compose support generates commands only; product repos own compose file, health, and persistence policy.');
    commands.push(
      { phase: 'status-before', command: `docker compose${compose} ps ${serviceArgs}` },
      { phase: 'restart', command: `docker compose${compose} restart ${serviceArgs}` },
      { phase: 'status-after', command: `docker compose${compose} ps ${serviceArgs}` },
      { phase: 'recent-logs', command: `docker compose${compose} logs --tail "$CW_LOG_EXCERPT_LINES" ${serviceArgs}` },
      { phase: 'stop', command: `docker compose${compose} stop ${serviceArgs}` },
    );
    return { manager, services: ids, persistenceClaim: 'compose persistence depends on product host configuration', warnings, commands };
  }

  if (manager === 'none') {
    warnings.push('manager=none is for dry-run/documentation mode only; it is not a restart mechanism.');
    return {
      manager,
      services: [],
      persistenceClaim: 'not implemented',
      warnings,
      commands: [
        { phase: 'status-before', command: 'echo "service manager disabled"' },
        { phase: 'restart', command: 'echo "service restart not implemented for manager=none"' },
        { phase: 'status-after', command: 'echo "service manager disabled"' },
        { phase: 'recent-logs', command: 'echo "service logs not implemented for manager=none"' },
        { phase: 'stop', command: 'echo "service stop not implemented for manager=none"' },
      ],
    };
  }

  throw new Error(`unsupported service manager: ${manager}`);
}

export function renderServiceManagerMarkdown(plan) {
  return `# Service Manager Plan

- manager: ${plan.manager}
- services: ${plan.services.length ? plan.services.join(', ') : 'none'}
- persistence claim: ${plan.persistenceClaim}

## Commands

${markdownTable(['phase', 'command'], plan.commands.map((item) => [item.phase, item.command]))}

## Warnings

${plan.warnings.length ? plan.warnings.map((item) => `- ${item}`).join('\n') : 'No warnings.'}
`;
}

function planFromConfig(args) {
  if (!args['--config']) return null;
  const config = readJsonFile(args['--config']);
  const targetName = args['--target'];
  if (!targetName) throw new Error('--target is required with --config');
  const target = config.targets?.[targetName];
  if (!target) throw new Error(`target ${targetName} not found in ${args['--config']}`);
  return buildServiceManagerPlan({
    manager: target.manager,
    services: target.services,
    composeFile: target.composeFile,
  });
}

async function main() {
  const args = parseArgs();
  if (args['--help']) {
    console.log('Usage: node scripts/service-manager-plan.mjs --manager systemd --services api,worker [--json] [--output path]');
    return;
  }
  try {
    const corePlan = planFromConfig(args) ?? buildServiceManagerPlan({
      manager: args['--manager'],
      services: args['--services'],
      composeFile: args['--compose-file'],
    });
    const plan = { schemaVersion: 1, kind: 'service-manager-plan', generatedAt: nowIso(), ...corePlan };
    if (args['--output']) {
      const out = path.resolve(args['--output']);
      if (out.endsWith('.json')) {
        writeJsonFile(out, plan);
      } else {
        writeFileSync(out, renderServiceManagerMarkdown(plan), 'utf8');
      }
    }
    if (args['--json']) {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      console.log(redact(renderServiceManagerMarkdown(plan)));
    }
  } catch (error) {
    fail(redact(error.message), 2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
