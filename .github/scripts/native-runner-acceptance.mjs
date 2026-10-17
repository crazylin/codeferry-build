/** Run only controlled actual-Runner tests; raw output belongs in ci-task's private log. */
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const acceptanceFilter = 'runner::native_tests::actual::actual_shared_runner_';
const commonTests = Object.freeze([
  'add_remove_and_reopen_project_without_replay',
]);
const unixTests = Object.freeze([
  'disconnect_keeps_effect_once_and_sibling_available',
  'retirement_reaps_a_shell_group_preserving_b_shell',
  'persistent_timeout_never_accepts_unsynchronized_work',
  'guard_preserves_stdin_output_and_exit_status',
  'persistent_shell_retirement_and_shutdown',
  'crash_cleans_active_persistent_shell',
  'crash_fences_and_cleans_independent_shell',
  'stdin_eof_writes_recoverable_shutdown_receipt_without_replay',
  'fatal_transport_exit_writes_receipt_and_restarts_without_replay',
  'fatal_transport_exit_cleans_independent_shell_before_receipt',
]);

export function expectedTests(platform) {
  if (!['darwin', 'linux', 'win32'].includes(platform)) throw Error('NATIVE_RUNNER_ACCEPTANCE_PLATFORM_INVALID');
  return [...commonTests, ...(platform === 'win32' ? [] : unixTests)].map(name => acceptanceFilter + name);
}

export function assertNativeRunnerAcceptance(output, platform) {
  const text = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const expected = expectedTests(platform);
  const reports = [...text.matchAll(/^test result: ok\. (\d+) passed; 0 failed; 0 ignored;[^\r\n]*$/gm)];
  if (reports.length !== 1 || Number(reports[0][1]) < expected.length || /test result: FAILED\./u.test(text)) {
    throw Error('NATIVE_RUNNER_ACCEPTANCE_NOT_EXECUTED');
  }
  for (const name of expected) {
    const line = `test ${name} ... ok`;
    if (!text.split(/\r?\n/u).some(value => value.trim() === line)) {
      throw Error('NATIVE_RUNNER_ACCEPTANCE_TEST_MISSING');
    }
  }
  return Number(reports[0][1]);
}

export async function runNativeRunnerAcceptance(source, {
  platform = process.platform, environment = process.env, spawnChild = spawn,
  timeoutMs = 30 * 60 * 1000, graceMs = 1500, maximumBytes = 4 * 1024 * 1024,
  writeOutput = bytes => process.stdout.write(bytes),
} = {}) {
  expectedTests(platform);
  const binary = join(source, 'runtime', platform === 'win32' ? 'codeferry-runner.exe' : 'codeferry-runner');
  await new Promise((resolveAcceptance, rejectAcceptance) => {
    let child, escalation, exited = false, finished = false, failure, bytes = 0;
    let stdout = [], raw = [];
    const stop = signal => {
      if (child && !exited) {
        try { child.kill(signal); } catch { /* Preserve the uncertain failure. */ }
      }
    };
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearTimeout(escalation);
      child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
      try {
        if (raw.length) writeOutput(Buffer.concat(raw));
        if (!error) assertNativeRunnerAcceptance(Buffer.concat(stdout).toString('utf8'), platform);
      } catch (cause) { error ??= cause; }
      stdout = []; raw = [];
      if (error) rejectAcceptance(error); else resolveAcceptance();
    };
    const interrupt = code => {
      if (finished || failure) return;
      failure = Object.assign(Error(code), { cleanup: 'unknown' });
      // Settle independently of inherited pipes or an absent Child close event.
      // Signals apply only to this spawned Child; no effectful test is retried.
      escalation = setTimeout(() => { stop('SIGKILL'); finish(failure); }, graceMs);
      stop('SIGTERM');
    };
    const append = (chunk, isStdout) => {
      if (finished || failure) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maximumBytes) { interrupt('NATIVE_RUNNER_ACCEPTANCE_OUTPUT_LIMIT'); return; }
      raw.push(buffer); if (isStdout) stdout.push(buffer);
    };
    const deadline = setTimeout(() => interrupt('NATIVE_RUNNER_ACCEPTANCE_TIMEOUT'), timeoutMs);
    try {
      child = spawnChild('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--lib',
        acceptanceFilter, '--', '--ignored', '--test-threads=1', '--nocapture'], {
        cwd: join(source, 'desktop-tauri'),
        env: { ...environment, CODEFERRY_TEST_RUNNER: binary },
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      child.stdout?.on('data', chunk => append(chunk, true));
      child.stderr?.on('data', chunk => append(chunk, false));
      child.on('error', () => interrupt('NATIVE_RUNNER_ACCEPTANCE_FAILED'));
      child.once('exit', () => { exited = true; });
      child.once('close', (code, signal) => finish(failure ?? (code === 0 && !signal ? undefined : Error('NATIVE_RUNNER_ACCEPTANCE_FAILED'))));
    } catch { interrupt('NATIVE_RUNNER_ACCEPTANCE_FAILED'); }
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const source = resolve('source');
  const { publicBuildEnvironment } = await import(pathToFileURL(join(source, 'scripts/signing-environment.mjs')));
  await runNativeRunnerAcceptance(source, { environment: publicBuildEnvironment(process.env) });
}
