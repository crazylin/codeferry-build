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

test('code-less Rust failures expose fixed categories while dependency and test names stay private', async () => {
  await run(`console.error('error: failed to run custom build command for PRIVATE_DEPENDENCY');
    console.error('The system library SECRET_PACKAGE required by crate PRIVATE_CRATE was not found');
    console.error('pkg-config exited with status code 1');
    console.error('test PRIVATE_TEST ... FAILED');
    console.error('test result: FAILED. 3 passed; 1 failed;');
    console.error('error: could not compile PRIVATE_RUST_CRATE (signal: 9, SIGKILL: kill)');
    console.error('token=SUPER_PRIVATE_TOKEN');process.exit(101);`, async (result, path) => {
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'CI_TASK_FAILED_FIXTURE_CONTRACTS\nCI_TASK_DIAGNOSTICS exit_code=101 signal=none compiler_codes=none\nCI_TASK_FAILURE_KINDS compiler_sigkill,custom_build_failed,missing_system_library,pkg_config_failed,tests_failed\n');
    for (const privateValue of ['PRIVATE_DEPENDENCY', 'SECRET_PACKAGE', 'PRIVATE_CRATE', 'PRIVATE_TEST', 'SUPER_PRIVATE_TOKEN']) {
      assert.ok(!result.stderr.includes(privateValue));
      assert.match(await readFile(path, 'utf8'), new RegExp(privateValue));
    }
  });
});

test('failure category scanning is bounded and does not copy arbitrary diagnostic labels', async () => {
  await run(`console.error('error: failed to run custom build command for PRIVATE_DEPENDENCY');
    process.stderr.write('x'.repeat(300 * 1024));
    console.error('\\nerror: proc macro panicked');
    console.error('error: linking with PRIVATE_LINKER failed: exit status: 1');
    console.error('fatal runtime error: out of memory');
    console.error('No space left on device');
    console.error('failure_kinds=SUPER_PRIVATE_TOKEN');process.exit(101);`, async result => {
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'CI_TASK_FAILED_FIXTURE_CONTRACTS\nCI_TASK_DIAGNOSTICS exit_code=101 signal=none compiler_codes=none\nCI_TASK_FAILURE_KINDS compiler_out_of_memory,disk_full,linker_failed,proc_macro_panicked\n');
  });
});

test('missing build tools and assets report categories without their private names or paths', async () => {
  const diagnostics = [
    'error: linker `PRIVATE_LINKER` not found',
    'failed to find tool PRIVATE_C_COMPILER: No such file or directory',
    'The `frontendDist` configuration is set to `/private/source/dist` but this path doesn\'t exist',
    'error: failed to select a version for PRIVATE_DEPENDENCY',
    'cfr_publish_SUPER_PRIVATE_TOKEN',
  ].join('\n');
  await run(`console.error(${JSON.stringify(diagnostics)});process.exit(101);`, async result => {
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'CI_TASK_FAILED_FIXTURE_CONTRACTS\nCI_TASK_DIAGNOSTICS exit_code=101 signal=none compiler_codes=none\nCI_TASK_FAILURE_KINDS dependency_resolution_failed,missing_c_compiler,missing_frontend_dist,missing_linker\n');
  });
});

test('native browser evidence and Python timeout expose only fixed failure classes', async () => {
  const diagnostics = 'subprocess.TimeoutExpired: Command /private/source/browser-proof timed out\n' + JSON.stringify({ passed: false, reports: 0, output: '/private/source/evidence/latest.json', problems: ['PRIVATE_PROBLEM_SUPER_TOKEN'] });
  await run(`console.error(${JSON.stringify(diagnostics)});process.exit(1);`, async result => {
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'CI_TASK_FAILED_FIXTURE_CONTRACTS\nCI_TASK_DIAGNOSTICS exit_code=1 signal=none compiler_codes=none\nCI_TASK_FAILURE_KINDS native_browser_fixture_failed,python_subprocess_timeout\n');
  });
});

test('a successful native fixture or unbounded separated JSON markers do not become a native failure', async () => {
  const diagnostics = JSON.stringify({ passed: true, problems: [] }) + '\n"passed": false,' + 'x'.repeat(16385) + '"problems": []';
  await run(`console.error(${JSON.stringify(diagnostics)});process.exit(1);`, async result => {
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'CI_TASK_FAILED_FIXTURE_CONTRACTS\nCI_TASK_DIAGNOSTICS exit_code=1 signal=none compiler_codes=none\n');
  });
});
