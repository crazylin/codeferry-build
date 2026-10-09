import test from 'node:test';
import assert from 'node:assert/strict';
import { matchingProofs, provedSingleExecution, PROOFS } from '../require-windows-real-runner.mjs';

test('native Runner proof list cannot silently accept missing or ambiguous tests', () => {
  for (const name of PROOFS) {
    assert.equal(matchingProofs('0 tests, 0 benchmarks', name).length, 0);
    assert.equal(matchingProofs(`runner::sandbox::windows::broker::${name}: test\n`, name).length, 1);
    assert.equal(matchingProofs(`runner::sandbox::windows::broker::${name}: test\nrunner::sandbox::windows::broker::${name}: test\n`, name).length, 2);
  }
});

test('native Runner proof must execute exactly one passing test', () => {
  assert.equal(provedSingleExecution('running 0 tests\ntest result: ok. 0 passed; 0 failed;'), false);
  assert.equal(provedSingleExecution('running 1 test\ntest result: FAILED. 0 passed; 1 failed;'), false);
  assert.equal(provedSingleExecution('running 2 tests\ntest result: ok. 2 passed; 0 failed;'), false);
  assert.equal(provedSingleExecution('running 1 test\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out;'), true);
});
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test('codeferry-build checks out an exact source SHA and compiles actual Runner before Windows acceptance', async () => {
  const dir = resolve(import.meta.dirname, '../../workflows');
  const diagnostic = await readFile(resolve(dir, 'desktop-diagnostics.yml'), 'utf8');
  const release = await readFile(resolve(dir, 'desktop-clients.yml'), 'utf8');
  assert.match(diagnostic, /ref: \$\{\{ inputs\.source_commit \}\}/u);
  assert.match(diagnostic, /SOURCE_COMMIT_MUST_BE_EXACT_SHA/u);
  for (const text of [diagnostic, release]) {
    assert.match(text, /native-runtime node scripts\/native-build\.mjs/u);
    assert.match(text, /windows-broker cargo build --locked --manifest-path src-tauri\/Cargo\.toml --bin codeferry-windows-broker/u);
    assert.match(text, /CODEFERRY_RUNNER_TEST_EXE: \$\{\{ github\.workspace \}\}\/source\/runtime\/codeferry-runner\.exe/u);
    assert.match(text, /CODEFERRY_BROKER_TEST_EXE: \$\{\{ github\.workspace \}\}\/source\/desktop-tauri\/src-tauri\/target\/debug\/codeferry-windows-broker\.exe/u);
    assert.match(text, /windows-real-runner-appcontainer node \.\.\/\.\.\/\.github\/scripts\/require-windows-real-runner\.mjs/u);
    assert.ok(text.indexOf('native-build.mjs') < text.indexOf('windows-real-runner-appcontainer'));
    assert.ok(text.indexOf('windows-broker cargo build') < text.indexOf('windows-real-runner-appcontainer'));
  }
  assert.match(diagnostic, /if: runner\.os == 'Windows'\n        working-directory: source\n/u);
  assert.match(release, /CODEFERRY_TEST_RUNNER: \$\{\{ github\.workspace \}\}\/source\/runtime\/\$\{\{ matrix\.runner \}\}/u);
});
