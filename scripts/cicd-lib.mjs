#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq >= 0) {
      out[token.slice(0, eq)] = token.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[token] = next;
      i += 1;
    } else {
      out[token] = true;
    }
  }
  return out;
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

export function readJsonFile(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writeJsonFile(file, value) {
  ensureDir(path.dirname(file));
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function nowIso() {
  return new Date().toISOString();
}

export function repoRootFrom(start = process.cwd()) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: start,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return path.resolve(start);
  }
}

export function gitInfo(repoRoot) {
  const run = (args) => execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  try {
    return {
      isGitRepo: true,
      branch: run(['branch', '--show-current']),
      headSha: run(['rev-parse', 'HEAD']),
      dirtyFiles: run(['status', '--porcelain']).split('\n').filter(Boolean),
    };
  } catch (error) {
    return {
      isGitRepo: false,
      branch: null,
      headSha: null,
      dirtyFiles: [],
      error: error.message,
    };
  }
}

const URL_RE = /\bhttps?:\/\/[^\s'"<>`]+/g;
const SECRET_ASSIGNMENT_RE = /\b([A-Za-z0-9_./-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|AUTHORIZATION|SIGNATURE|CREDENTIAL)[A-Za-z0-9_./-]*)(\s*[:=]\s*)([^\s'",;]+)/gi;
const AUTH_HEADER_RE = /\b(authorization\s*[:=]\s*)(bearer|basic)?\s*[^\s'",;]+/gi;
const QUERY_SECRET_RE = /([?&](?:token|secret|password|passwd|api[_-]?key|access[_-]?key|signature|sig|x-amz-signature|credential|expires)=)[^&\s]+/gi;

export function redact(value) {
  if (value == null) return value;
  let text = String(value);
  text = text.replace(URL_RE, (raw) => {
    try {
      const parsed = new URL(raw);
      const auth = parsed.username || parsed.password ? '<redacted-userinfo>@' : '';
      const query = parsed.search ? '?<redacted-query>' : '';
      return `${parsed.protocol}//${auth}${parsed.host}${parsed.pathname}${query}${parsed.hash}`;
    } catch {
      return raw.replace(QUERY_SECRET_RE, '$1<redacted>');
    }
  });
  text = text.replace(AUTH_HEADER_RE, '$1<redacted>');
  text = text.replace(SECRET_ASSIGNMENT_RE, '$1$2<redacted>');
  text = text.replace(QUERY_SECRET_RE, '$1<redacted>');
  return text;
}

export function shQuote(value) {
  const text = String(value);
  if (text.length === 0) return "''";
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function sanitizeId(id) {
  const safe = String(id ?? '').trim().replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'unnamed';
}

export function runShellCommand(command, { cwd, env = process.env } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code, signal) => {
      resolve({
        command,
        exitCode: code,
        signal,
        durationMs: Date.now() - startedAt,
        stdout: redact(stdout),
        stderr: redact(stderr),
      });
    });
  });
}

export function execGh(args, { input } = {}) {
  const result = spawnSync('gh', args, {
    input,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = redact(result.stderr || result.stdout || `gh exited ${result.status}`);
    throw new Error(detail.trim());
  }
  return result.stdout;
}

export function commandExists(name) {
  const result = spawnSync('sh', ['-lc', `command -v ${shQuote(name)} >/dev/null 2>&1`], {
    stdio: 'ignore',
  });
  return result.status === 0;
}

export function markdownTable(headers, rows) {
  const esc = (cell) => String(cell ?? '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
  return [
    `| ${headers.map(esc).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(esc).join(' | ')} |`),
  ].join('\n');
}

export function outputDirDefault(kind, suffix = '') {
  const parts = [process.cwd(), 'tmp', 'coding-workflow', kind];
  if (suffix) parts.push(sanitizeId(suffix));
  return path.join(...parts);
}

export function readIfExists(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

export function appendJsonl(file, value) {
  ensureDir(path.dirname(file));
  const existing = readIfExists(file);
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  writeFileSync(file, `${existing}${prefix}${JSON.stringify(value)}\n`, 'utf8');
}

export function hostFacts() {
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
  };
}

export function fail(message, code = 2) {
  console.error(message);
  process.exit(code);
}
