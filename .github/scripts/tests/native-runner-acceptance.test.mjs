import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { acceptanceFilter, expectedTests, assertNativeRunnerAcceptance, runNativeRunnerAcceptance } from '../native-runner-acceptance.mjs';

const source = join(process.cwd(), 'fixture-source');
const report = (platform, extra = '') => expectedTests(platform).map(name => `test ${name} ... ok\n`).join('')
  + `test result: ok. ${expectedTests(platform).length} passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.00s\n${extra}`;
function childFixture(run) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.signals = []; child.kill = signal => { child.signals.push(signal); return true; };
  child.unref = () => {};
  queueMicrotask(() => run(child));
  return child;
}

test('all platforms require actual common tests and Unix requires new crash and protocol evidence', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    assert.equal(assertNativeRunnerAcceptance(report(platform), platform), expectedTests(platform).length);
    assert.ok(expectedTests(platform).every(name => name.startsWith(acceptanceFilter)));
  }
  assert.equal(expectedTests('win32').length, 1);
  for (const platform of ['darwin', 'linux']) {
    assert.ok(expectedTests(platform).some(name => name.endsWith('crash_cleans_active_persistent_shell')));
    assert.ok(expectedTests(platform).some(name => name.endsWith('crash_fences_and_cleans_independent_shell')));
  }
  assert.throws(() => expectedTests('unsupported'), /PLATFORM_INVALID/);
});

test('zero tests, ignored tests, missing named tests and mixed failed reports are rejected', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    assert.throws(() => assertNativeRunnerAcceptance('test result: ok. 0 passed; 0 failed; 0 ignored;\n', platform), /NOT_EXECUTED/);
    assert.throws(() => assertNativeRunnerAcceptance(report(platform).replace('0 ignored', '1 ignored'), platform), /NOT_EXECUTED/);
    assert.throws(() => assertNativeRunnerAcceptance(report(platform).replace(expectedTests(platform)[0], 'unrelated_test'), platform), /TEST_MISSING/);
    assert.throws(() => assertNativeRunnerAcceptance(report(platform, 'test result: FAILED. 0 passed; 1 failed;\n'), platform), /NOT_EXECUTED/);
    assert.throws(() => assertNativeRunnerAcceptance(report(platform) + report(platform), platform), /NOT_EXECUTED/);
  }
});

test('colored Windows CRLF reports and additional successful selected tests remain valid', () => {
  const windows = report('win32').replaceAll('\n', '\r\n');
  assert.equal(assertNativeRunnerAcceptance(`\x1b[32m${windows}\x1b[0m`, 'win32'), 1);
  assert.equal(assertNativeRunnerAcceptance(report('linux').replace('8 passed', '9 passed'), 'linux'), 9);
});

test('the exact rebuilt platform binary overrides inherited Runner path and runs ignored tests once', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    let calls = 0, output = '';
    await runNativeRunnerAcceptance(source, {
      platform, environment: { FIXTURE: 'synthetic', CODEFERRY_TEST_RUNNER: '/wrong-binary' },
      writeOutput: bytes => { output += bytes.toString('utf8'); },
      spawnChild: (file, args, options) => {
        calls++;
        assert.equal(file, 'cargo'); assert.ok(args.includes('--locked')); assert.ok(args.includes('--lib'));
        assert.ok(args.includes(acceptanceFilter)); assert.ok(args.includes('--ignored'));
        assert.ok(args.includes('--test-threads=1')); assert.equal(options.cwd, join(source, 'desktop-tauri'));
        assert.equal(options.env.CODEFERRY_TEST_RUNNER, join(source, 'runtime', platform === 'win32' ? 'codeferry-runner.exe' : 'codeferry-runner'));
        return childFixture(child => { child.stdout.end(report(platform)); child.emit('exit', 0); child.emit('close', 0); });
      },
    });
    assert.equal(calls, 1); assert.ok(output.includes('test result: ok.'));
  }
});

test('successful Cargo exit with no actual tests still fails acceptance', async () => {
  await assert.rejects(runNativeRunnerAcceptance(source, {
    platform: 'win32', writeOutput: () => {}, spawnChild: () => childFixture(child => {
      child.stdout.end('test result: ok. 0 passed; 0 failed; 0 ignored;\n'); child.emit('exit', 0); child.emit('close', 0);
    }),
  }), /NOT_EXECUTED/);
});

test('positive output cannot hide a failed Cargo status and no test is replayed', async () => {
  let calls = 0;
  await assert.rejects(runNativeRunnerAcceptance(source, {
    platform: 'win32', writeOutput: () => {}, spawnChild: () => { calls++; return childFixture(child => {
      child.stdout.end(report('win32')); child.emit('exit', 101); child.emit('close', 101);
    }); },
  }), /ACCEPTANCE_FAILED/);
  assert.equal(calls, 1);
});

test('bounded timeout settles even if the spawned child and inherited pipes never close', async () => {
  let child, calls = 0;
  await assert.rejects(runNativeRunnerAcceptance(source, {
    platform: 'linux', timeoutMs: 5, graceMs: 5, writeOutput: () => {},
    spawnChild: () => { calls++; child = childFixture(() => {}); return child; },
  }), /ACCEPTANCE_TIMEOUT/);
  assert.equal(calls, 1); assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.ok(child.stdout.destroyed && child.stderr.destroyed);
});

test('raw output is bounded and late close cannot turn an interrupted run into success', async () => {
  let child;
  await assert.rejects(runNativeRunnerAcceptance(source, {
    platform: 'win32', maximumBytes: 10, graceMs: 5, writeOutput: () => {},
    spawnChild: () => { child = childFixture(value => { value.stdout.write('x'.repeat(11)); }); return child; },
  }), /OUTPUT_LIMIT/);
  child.emit('exit', 0); child.emit('close', 0); child.emit('error', Error('late fixture failure'));
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
});
