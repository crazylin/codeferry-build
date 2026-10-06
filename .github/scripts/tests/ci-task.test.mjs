import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const wrapper = fileURLToPath(new URL('../ci-task.mjs', import.meta.url));
async function run(script, check) {
  const directory = await mkdtemp(join(tmpdir(), 'codeferry-ci-diagnostics-'));
  try {
    const result = spawnSync(process.execPath, [wrapper, 'fixture-contracts', process.execPath, '-e', script], {
      encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: directory },
    });
    await check(result, join(directory, 'private-codeferry-logs/fixture-contracts.log'));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('failed tasks expose exit and compiler codes while raw source and secrets remain private', async () => {
  await run(`console.error('/private/source/client.ts(12,3): error TS2307: Missing secret cfr_publish_FAKE_SECRET');
    console.error('error[E0308]: private source code here');
    console.error('error TS2307: another source-looking value');
    console.error('token=SUPER_PRIVATE_TOKEN');process.exit(7);`, async (result, path) => {
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'CI_TASK_FAILED_FIXTURE_CONTRACTS\nCI_TASK_DIAGNOSTICS exit_code=7 signal=none compiler_codes=E0308,TS2307\n');
    const log = await readFile(path, 'utf8');
    assert.match(log, /SUPER_PRIVATE_TOKEN/);
    assert.match(log, /\/private\/source\/client.ts/);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
});

test('successful tasks preserve the existing success output without exposing child output', async () => {
  await run("console.log('SUPER_PRIVATE_SUCCESS_OUTPUT');", async (result, path) => {
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'CI_TASK_PASSED_FIXTURE_CONTRACTS\n');
    assert.equal(result.stderr, '');
    assert.match(await readFile(path, 'utf8'), /SUPER_PRIVATE_SUCCESS_OUTPUT/);
  });
});

test('compiler scanning is bounded and excludes source-looking arbitrary diagnostic values', async () => {
  await run(`console.error('error TS2307: earlier private source');
    process.stderr.write('x'.repeat(300 * 1024));
    console.error('\\nerror TS18046: private ending');
    console.error('error BAD_CODE: secret');process.exit(2);`, async result => {
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'CI_TASK_FAILED_FIXTURE_CONTRACTS\nCI_TASK_DIAGNOSTICS exit_code=2 signal=none compiler_codes=TS18046\n');
  });
});

test('signal termination is reported without copying private child text', { skip: process.platform === 'win32' }, async () => {
  await run("console.error('SUPER_PRIVATE_SIGNAL');process.kill(process.pid,'SIGTERM');", async result => {
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'CI_TASK_FAILED_FIXTURE_CONTRACTS\nCI_TASK_DIAGNOSTICS exit_code=none signal=SIGTERM compiler_codes=none\n');
  });
});
