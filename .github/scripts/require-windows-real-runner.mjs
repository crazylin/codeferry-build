/**
 * Windows-only, private-log real Runner AppContainer acceptance.
 *
 * Require evidence that each exact native test exists AND executes once.
 * Plain `cargo test FILTER` may succeed with zero matching tests.
 * Only fixed status labels leave this helper; raw Rust output stays in memory.
 */
import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROOFS = Object.freeze([
  'windows_real_runner_executable_starts_inside_appcontainer_without_credentials',
  'windows_real_runner_nested_broker_appcontainer_no_credentials',
]);

export function matchingProofs(output, name) {
  return output.split(/\r?\n/u)
    .filter(line => line.trim().endsWith(`::${name}: test`) ||
      line.trim() === `${name}: test`);
}

export function provedSingleExecution(output) {
  return /(?:^|\r?\n)running 1 test\r?\n/u.test(output)
    && /(?:^|\r?\n)test result: ok\. 1 passed; 0 failed;/u.test(output);
}

function verifiedImage(environment, variable, relative, filename) {
  const workspace = environment.GITHUB_WORKSPACE;
  const supplied = environment[variable];
  if (!workspace || !supplied || basename(supplied).toLowerCase() !== filename ||
      resolve(supplied) !== resolve(join(workspace, relative))) {
    throw new Error('WINDOWS_PROOF_BINARY_PATH_INVALID');
  }
  const stat = lstatSync(supplied);
  if (!stat.isFile() || stat.isSymbolicLink() ||
      realpathSync(supplied).toLowerCase() !== resolve(supplied).toLowerCase()) {
    throw new Error('WINDOWS_PROOF_BINARY_NOT_REGULAR');
  }
}

function runCargo(cwd, name, list) {
  const args = ['test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml',
    '--lib', name, '--', ...(list ? ['--list'] : ['--test-threads=1'])];
  const result = spawnSync('cargo', args, {
    cwd, encoding: 'utf8', timeout: list ? 240_000 : 480_000,
    maxBuffer: 8 * 1024 * 1024, windowsHide: true, shell: false,
  });
  if (result.error || result.status !== 0 || result.signal ||
      typeof result.stdout !== 'string') {
    throw new Error(list ? 'WINDOWS_PROOF_DISCOVERY_FAILED' : 'WINDOWS_PROOF_EXECUTION_FAILED');
  }
  return result.stdout;
}

export function runWindowsProofs(environment = process.env) {
  if (process.platform !== 'win32' || environment.RUNNER_OS !== 'Windows') {
    throw new Error('WINDOWS_PROOF_PLATFORM_REQUIRED');
  }
  verifiedImage(environment, 'CODEFERRY_RUNNER_TEST_EXE',
    'source/runtime/codeferry-runner.exe', 'codeferry-runner.exe');
  verifiedImage(environment, 'CODEFERRY_BROKER_TEST_EXE',
    'source/desktop-tauri/src-tauri/target/debug/codeferry-windows-broker.exe',
    'codeferry-windows-broker.exe');
  const cwd = join(environment.GITHUB_WORKSPACE, 'source/desktop-tauri');
  for (const name of PROOFS) {
    const discovered = matchingProofs(runCargo(cwd, name, true), name);
    if (discovered.length !== 1) throw new Error('WINDOWS_PROOF_MISSING_OR_AMBIGUOUS');
    if (!provedSingleExecution(runCargo(cwd, name, false))) {
      throw new Error('WINDOWS_PROOF_NOT_EXECUTED_ONCE');
    }
    console.log('WINDOWS_NATIVE_APPCONTAINER_PROOF_PASSED');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runWindowsProofs();
  } catch (error) {
    console.error(/^WINDOWS_PROOF_[A-Z_]+$/u.test(error?.message ?? '')
      ? error.message : 'WINDOWS_PROOF_FAILED');
    process.exitCode = 1;
  }
}
