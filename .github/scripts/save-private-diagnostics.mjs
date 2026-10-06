/** Retain bounded pre-signing diagnostics only in the private source repository. */
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { open, lstat, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const diagnosticTasks = Object.freeze([
  'root-contracts', 'native-source', 'native-runtime', 'native-format', 'native-auth',
  'native-embedding', 'native-drain', 'gateway-contracts', 'gateway-worker',
  'tauri-types', 'tauri-frontend-types', 'tauri-frontend-build', 'tauri-contracts',
  'tauri-provider-guard', 'tauri-native-browser',
  'gateway-build', 'gateway-image', 'gateway-image-smoke', 'gateway-archive',
]);
const MAX_TAIL = 256 * 1024;
const MAX_SECRET = 64 * 1024;
const REDACTED = '[REDACTED]';
function secretValues(environment) {
  const values = new Set();
  for (const [key, value] of Object.entries(environment)) {
    if (!/TOKEN|PASSWORD|PASSPHRASE|SECRET|(?:^|_)KEY(?:_|$)|PRIVATE_KEY|PUBLISH_KEY|APIKEY|CREDENTIAL|AUTHORIZATION/i.test(key) || typeof value !== 'string' || !value.length) continue;
    for (const variant of [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]) {
      if (Buffer.byteLength(variant) > MAX_SECRET || values.size >= 256) throw Error('PRIVATE_DIAGNOSTIC_SECRET_LIMIT');
      values.add(variant);
    }
  }
  return [...values].sort((a, b) => b.length - a.length);
}
function credentialPatterns() {
  return [
    /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|cfr_publish_[A-Za-z0-9_-]{16,})/g,
    /\b(?:Bearer|Basic)\s+[^\s,"'<>]+/gi,
    /https?:\/\/[^\s"'<>]*\/mcp\/[^\s"'<>),;]+/gi,
    /https?:\/\/[^\s/"'<>]+:[^\s/"'<>]+@[^\s"'<>]+/gi,
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
    /["']?(?:authorization|password|secret|token|api[_-]?key|credentials?|private[_-]?key)["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi,
  ];
}
export function redactDiagnostics(raw, environment = process.env) {
  let text = raw;
  for (const value of secretValues(environment)) text = text.split(value).join(REDACTED);
  for (const pattern of credentialPatterns()) text = text.replace(pattern, REDACTED);
  return text;
}
function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function safeTail(raw, boundary, environment) {
  // A secret crossing the tail boundary must be discarded in full, rather
  // than retaining its suffix. The overlap covers every accepted secret.
  let start = boundary;
  for (const value of secretValues(environment)) {
    const index = raw.lastIndexOf(value, boundary);
    if (index >= 0 && index < boundary && index + value.length > boundary) start = Math.max(start, index + value.length);
  }
  for (const pattern of credentialPatterns()) {
    for (const match of raw.matchAll(pattern)) {
      if (match.index < boundary && match.index + match[0].length > boundary) start = Math.max(start, match.index + match[0].length);
    }
  }
  let tail = Buffer.from(redactDiagnostics(raw.slice(start), environment)).subarray(-MAX_TAIL).toString('utf8');
  while (Buffer.byteLength(tail) > MAX_TAIL) tail = tail.slice(1);
  return tail;
}
export async function collectDiagnostics(directory, environment = process.env) {
  let directoryInfo;
  try { directoryInfo = await lstat(directory); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw Error('PRIVATE_DIAGNOSTIC_DIRECTORY_INVALID');
  const records = [];
  for (const task of diagnosticTasks) {
    const path = join(directory, task + '.log');
    let before;
    try { before = await lstat(path); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw Error('PRIVATE_DIAGNOSTIC_FILE_INVALID');
    const input = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await input.stat();
      if (!info.isFile() || info.nlink !== 1 || !sameFile(before, info) || !Number.isSafeInteger(info.size) || info.size < 0) throw Error('PRIVATE_DIAGNOSTIC_FILE_INVALID');
      const bytes = Buffer.alloc(Math.min(info.size, MAX_TAIL + MAX_SECRET));
      const position = info.size - bytes.length;
      const read = await input.read(bytes, 0, bytes.length, position);
      if (read.bytesRead !== bytes.length || !sameFile(info, await lstat(path))) throw Error('PRIVATE_DIAGNOSTIC_FILE_CHANGED');
      const raw = bytes.toString('utf8');
      const boundary = bytes.subarray(0, Math.max(0, info.size - MAX_TAIL - position)).toString('utf8').length;
      records.push({ task, truncated: info.size > MAX_TAIL, tail: safeTail(raw, boundary, environment) });
    } finally { await input.close(); }
  }
  const after = await lstat(directory);
  if (!after.isDirectory() || after.isSymbolicLink() || !sameFile(directoryInfo, after)) throw Error('PRIVATE_DIAGNOSTIC_DIRECTORY_CHANGED');
  return records;
}
async function main() {
  const role = process.env.CODEFERRY_DIAGNOSTIC_ROLE;
  const run = process.env.GITHUB_RUN_ID, attempt = process.env.GITHUB_RUN_ATTEMPT;
  const source = process.env.SOURCE_SHA;
  if (!/^(validate|darwin-arm64|linux-x64|win32-x64|gateway-linux-x64)$/.test(role ?? '') ||
      !/^[0-9]{1,20}$/.test(run ?? '') || !/^[0-9]{1,6}$/.test(attempt ?? '') ||
      !/^[a-f0-9]{40}$/.test(source ?? '') || !isAbsolute(process.env.RUNNER_TEMP ?? '') ||
      process.env.RUNNER_TEMP.length > 4096 || process.env.RUNNER_TEMP.includes('\0') ||
      !/^\S{8,16384}$/.test(process.env.GH_TOKEN ?? '')) throw Error('PRIVATE_DIAGNOSTIC_CONFIGURATION_INVALID');
  const records = await collectDiagnostics(join(process.env.RUNNER_TEMP, 'private-codeferry-logs'));
  if (!records.length) { console.log('PRIVATE_BUILD_DIAGNOSTICS_EMPTY'); return; }
  const directory = await mkdtemp(join(process.env.RUNNER_TEMP, 'private-diagnostics-' + role + '-'));
  const file = join(directory, 'diagnostics.json');
  try {
    const raw = JSON.stringify({ schemaVersion: 1, role, sourceCommit: source, runId: run, attempt, records });
    if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw Error('PRIVATE_DIAGNOSTIC_TOO_LARGE');
    await writeFile(file, raw, { flag: 'wx', mode: 0o600 });
    // A separate private draft cannot enter the immutable release artifact set.
    // Creation is attempted once; unknown results are never replayed.
    execFileSync('gh', ['release', 'create', `diagnostics-${run}-${attempt}-${role}`, file,
      '--repo', 'crazylin/codeferry', '--draft', '--target', source,
      '--title', `Private build diagnostics ${run} ${role}`, '--notes', 'Bounded pre-signing diagnostics; not a release artifact.'],
      { stdio: 'ignore', timeout: 120_000 });
    console.log('PRIVATE_BUILD_DIAGNOSTICS_SAVED');
  } finally { await rm(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('PRIVATE_BUILD_DIAGNOSTICS_UNAVAILABLE'); process.exitCode = 0; });
}
