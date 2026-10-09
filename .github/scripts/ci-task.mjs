/** Keep private source diagnostics in ephemeral runner files, never public logs. */
import { spawn } from 'node:child_process';
import { diagnosticExitCode } from './task-exit-code.mjs';
import { open, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
const [task, ...command] = process.argv.slice(2);
if (!/^[a-z][a-z0-9-]{1,60}$/.test(task ?? '') || !command.length || !process.env.RUNNER_TEMP) {
  console.error('CI_TASK_INVALID'); process.exit(1);
}
const logs = join(process.env.RUNNER_TEMP, 'private-codeferry-logs');
await mkdir(logs, { recursive: true, mode: 0o700 });
const path = join(logs, task + '.log');
const output = await open(path, 'a', 0o600);
try {
  const startedAt = (await output.stat()).size;
  const child = spawn(command[0], command.slice(1), { stdio: ['ignore', output.fd, output.fd],
    shell: process.platform === 'win32' && /^(npm|npx)$/.test(command[0]) });
  const result = await new Promise(resolve => {
    child.once('error', () => resolve({ code: 1, signal: null }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0) {
    console.error('CI_TASK_FAILED_' + task.toUpperCase().replaceAll('-', '_'));
    // Raw diagnostics may contain private source or credentials. Read only a
    // bounded tail of this invocation and expose allowlisted compiler codes.
    const input = await open(path, 'r');
    let codes = [];
    let failureKinds = [];
    try {
      const size = (await input.stat()).size;
      const position = Math.max(startedAt, size - 256 * 1024);
      const bytes = Buffer.alloc(Math.max(0, size - position));
      const read = await input.read(bytes, 0, bytes.length, position);
      // Cargo forces ANSI colors in Actions; strip its bounded control sequences
      // before finding fixed diagnostic codes, without printing the source text.
      const raw = bytes.subarray(0, read.bytesRead).toString('utf8')
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
      codes = [...new Set([
        ...[...raw.matchAll(/\berror\s+(TS\d{4,5})\b/g)].map(match => match[1]),
        ...[...raw.matchAll(/\berror\[(E\d{4})\]/g)].map(match => match[1]),
      ])].sort().slice(0, 32);
      // Rust custom builds, killed compiler children and test assertions often
      // fail without an E-code. These fixed labels disclose no source, paths,
      // dependency names, test names or text captured from the private log.
      failureKinds = [
        ['compiler_sigkill', /\(signal:\s*9,\s*SIGKILL(?::\s*kill)?\)/],
        ['compiler_out_of_memory', /(?:memory allocation of \d+ bytes failed|fatal runtime error: out of memory)/],
        ['custom_build_failed', /error:\s*failed to run custom build command for/],
        ['proc_macro_panicked', /error:\s*proc macro panicked/],
        ['tests_failed', /test result: FAILED\./],
        ['landlock_abi_unavailable', /LANDLOCK_CHECK_ABI_UNAVAILABLE/],
        ['landlock_command_invalid', /LANDLOCK_CHECK_COMMAND_INVALID/],
        ['landlock_child_launch_failed', /LANDLOCK_CHECK_CHILD_LAUNCH/],
        ['landlock_workspace_write_denied', /LANDLOCK_CHECK_WORKSPACE_WRITABLE/],
        ['landlock_scratch_write_denied', /LANDLOCK_CHECK_SCRATCH_WRITABLE/],
        ['landlock_outside_write_allowed', /LANDLOCK_CHECK_OUTSIDE_WRITE_BLOCKED/],
        ['landlock_child_write_allowed', /LANDLOCK_CHECK_CHILD_WRITE_BLOCKED/],
        ['landlock_private_write_allowed', /LANDLOCK_CHECK_PRIVATE_WRITE_BLOCKED/],
        ['landlock_dev_null_write_denied', /LANDLOCK_CHECK_DEV_NULL_WRITABLE/],
        ['linker_failed', /error:\s*linking with [^\r\n]+ failed:\s*exit status:/],
        ['missing_linker', /error:\s*linker `[^\r\n]+` not found/],
        ['missing_c_compiler', /failed to find tool [^\r\n]+(?:No such file or directory|not found)/],
        ['pkg_config_failed', /pkg-config exited with status code/],
        ['missing_system_library', /The system library [^\r\n]+ required by crate [^\r\n]+ was not found/],
        ['missing_frontend_dist', /The `frontendDist` configuration is set to [^\r\n]+ but this path doesn't exist/],
        ['dependency_resolution_failed', /(?:failed to select a version for|no matching package named [^\r\n]+ found)/],
        ['disk_full', /(?:No space left on device|os error 28\b)/],
        ['python_subprocess_timeout', /\b(?:subprocess\.)?TimeoutExpired\b/],
        ['native_browser_fixture_failed', /"passed"\s*:\s*false\s*,[\s\S]{0,16384}?"problems"\s*:\s*\[/],
      ].filter(([, pattern]) => pattern.test(raw)).map(([kind]) => kind).sort();
    } finally { await input.close(); }
    const code = diagnosticExitCode(result.code);
    const signal = /^SIG[A-Z0-9]{1,16}$/.test(result.signal ?? '') ? result.signal : 'none';
    console.error(`CI_TASK_DIAGNOSTICS exit_code=${code} signal=${signal} compiler_codes=${codes.join(',') || 'none'}`);
    if (failureKinds.length) console.error('CI_TASK_FAILURE_KINDS ' + failureKinds.join(','));
    process.exitCode = 1;
  }
  else console.log('CI_TASK_PASSED_' + task.toUpperCase().replaceAll('-', '_'));
} finally { await output.close(); }
