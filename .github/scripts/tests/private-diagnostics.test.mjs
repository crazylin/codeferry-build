import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink, link, mkdir, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { collectDiagnostics, redactDiagnostics, diagnosticTasks } from '../save-private-diagnostics.mjs';
const collector = fileURLToPath(new URL('../save-private-diagnostics.mjs', import.meta.url));

test('private diagnostic collection excludes all signing and publication tasks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'private-diagnostics-test-'));
  try {
    await writeFile(join(directory, 'tauri-contracts.log'), 'compiler fixture');
    await writeFile(join(directory, 'tauri-bundle.log'), 'signing output must never be retained');
    await writeFile(join(directory, 'tauri-macos-finalize.log'), 'signing output');
    await writeFile(join(directory, 'arbitrary.log'), 'not allowlisted');
    assert.deepEqual(await collectDiagnostics(directory, {}), [{ task: 'tauri-contracts', truncated: false, tail: 'compiler fixture' }]);
    assert.ok(!diagnosticTasks.some(task => /bundle|finalize|publish/.test(task)));
    for (const task of ['gateway-build', 'gateway-image', 'gateway-image-smoke', 'gateway-archive', 'native-format', 'tauri-frontend-types', 'windows-broker', 'windows-real-runner-appcontainer']) assert.ok(diagnosticTasks.includes(task));
    assert.ok(!diagnosticTasks.includes('collect-tauri'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('diagnostics redact scoped environment secrets and known tokens', () => {
  const token = 'ghp_' + 'a'.repeat(30), publisher = 'cfr_publish_' + 'b'.repeat(25);
  const output = redactDiagnostics(`fixture ${token} ${publisher} synthetic-password-value`, { GH_TOKEN: token, DB_PASSWORD: 'synthetic-password-value' });
  assert.equal(output, 'fixture [REDACTED] [REDACTED] [REDACTED]');
});
test('private diagnostics retain only a bounded tail for each known task', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'private-diagnostics-test-'));
  try {
    await writeFile(join(directory, 'tauri-contracts.log'), 'excluded-start' + 'x'.repeat(300 * 1024) + 'tail-end');
    const records = await collectDiagnostics(directory, {});
    assert.equal(records.length, 1); assert.equal(records[0].truncated, true);
    assert.equal(Buffer.byteLength(records[0].tail), 256 * 1024);
    assert.ok(!records[0].tail.includes('excluded-start')); assert.ok(records[0].tail.endsWith('tail-end'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('private diagnostics reject symbolic links, hard links and nonregular inputs before reading', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'private-diagnostics-links-'));
  try {
    const directory = join(root, 'logs'); await mkdir(directory);
    const secret = join(root, 'secret'); await writeFile(secret, 'SUPER_PRIVATE_LINK_TARGET');
    const log = join(directory, 'tauri-contracts.log');
    await symlink(secret, log);
    await assert.rejects(collectDiagnostics(directory, {}), /PRIVATE_DIAGNOSTIC_FILE_INVALID/);
    await rm(log); await link(secret, log);
    await assert.rejects(collectDiagnostics(directory, {}), /PRIVATE_DIAGNOSTIC_FILE_INVALID/);
    await rm(log); await mkdir(log);
    await assert.rejects(collectDiagnostics(directory, {}), /PRIVATE_DIAGNOSTIC_FILE_INVALID/);
    await symlink(directory, join(root, 'linked-logs'));
    await assert.rejects(collectDiagnostics(join(root, 'linked-logs'), {}), /PRIVATE_DIAGNOSTIC_DIRECTORY_INVALID/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('redaction covers short, escaped and URI encoded environment secrets and common credential forms', () => {
  const secret = 'private-password\\"with space';
  const diagnostics = [
    'short=abcd', secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret),
    'Authorization: Bearer SUPER_PRIVATE_BEARER',
    'https://codeferry.link/mcp/account-id/SUPER_PRIVATE_PATH_CREDENTIAL',
    'https://private-user:SUPER_PRIVATE_URL_PASSWORD@example.com/',
    '{"apiKey":"SUPER_PRIVATE_API_KEY"}',
    '-----BEGIN PRIVATE KEY-----\nSUPER_PRIVATE_KEY_BODY\n-----END PRIVATE KEY-----',
  ].join('\n');
  const output = redactDiagnostics(diagnostics, { DB_PASSWORD: 'abcd', PROVIDER_APIKEY: secret });
  for (const value of ['abcd', secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), 'SUPER_PRIVATE_BEARER', 'SUPER_PRIVATE_PATH_CREDENTIAL', 'SUPER_PRIVATE_URL_PASSWORD', 'SUPER_PRIVATE_API_KEY', 'SUPER_PRIVATE_KEY_BODY']) assert.ok(!output.includes(value));
});

test('a secret crossing the bounded tail boundary is discarded completely', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'private-diagnostics-boundary-'));
  try {
    const secret = 'SYNTHETIC_BOUNDARY_SECRET_' + 'z'.repeat(200);
    const suffix = 'x'.repeat(256 * 1024 - Math.floor(secret.length / 2));
    await writeFile(join(directory, 'tauri-contracts.log'), 'earlier-' + 'y'.repeat(128 * 1024) + secret + suffix);
    const records = await collectDiagnostics(directory, { GH_TOKEN: secret });
    assert.equal(records[0].truncated, true);
    assert.equal(records[0].tail, suffix);
    assert.ok(Buffer.byteLength(records[0].tail) <= 256 * 1024);
    assert.throws(() => redactDiagnostics('fixture', { GH_TOKEN: 's'.repeat(64 * 1024 + 1) }), /PRIVATE_DIAGNOSTIC_SECRET_LIMIT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('invalid configuration is best effort and does not create files or invoke publication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'private-diagnostics-config-'));
  try {
    const logs = join(directory, 'private-codeferry-logs'); await mkdir(logs);
    await writeFile(join(logs, 'tauri-contracts.log'), 'PRIVATE_SOURCE_AND_TOKEN');
    const valid = { ...process.env, RUNNER_TEMP: directory, CODEFERRY_DIAGNOSTIC_ROLE: 'linux-x64', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', SOURCE_SHA: 'a'.repeat(40), GH_TOKEN: 'synthetic-private-token' };
    for (const invalid of [
      { CODEFERRY_DIAGNOSTIC_ROLE: '../secret' }, { GITHUB_RUN_ID: '1'.repeat(21) },
      { GITHUB_RUN_ATTEMPT: '1'.repeat(7) }, { SOURCE_SHA: 'private-source' },
      { RUNNER_TEMP: 'relative-directory' }, { GH_TOKEN: '' }, { GH_TOKEN: 'secret\nvalue' },
    ]) {
      const result = spawnSync(process.execPath, [collector], { encoding: 'utf8', env: { ...valid, ...invalid } });
      assert.equal(result.status, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'PRIVATE_BUILD_DIAGNOSTICS_UNAVAILABLE\nPRIVATE_BUILD_DIAGNOSTICS_REASON_PRIVATE_DIAGNOSTIC_CONFIGURATION_INVALID\n');
      assert.deepEqual(await readdir(directory), ['private-codeferry-logs']);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('oversized serialized diagnostics are rejected and temporary output is removed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'private-diagnostics-size-'));
  try {
    const logs = join(directory, 'private-codeferry-logs'); await mkdir(logs);
    for (const task of diagnosticTasks) await writeFile(join(logs, task + '.log'), '\u0001'.repeat(256 * 1024));
    const result = spawnSync(process.execPath, [collector], { encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: directory, CODEFERRY_DIAGNOSTIC_ROLE: 'linux-x64', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', SOURCE_SHA: 'a'.repeat(40), GH_TOKEN: 'synthetic-private-token' } });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'PRIVATE_BUILD_DIAGNOSTICS_UNAVAILABLE\nPRIVATE_BUILD_DIAGNOSTICS_REASON_PRIVATE_DIAGNOSTIC_TOO_LARGE\n');
    assert.deepEqual(await readdir(directory), ['private-codeferry-logs']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
