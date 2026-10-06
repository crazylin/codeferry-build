/** Keep private source diagnostics in ephemeral runner files, never public logs. */
import { spawn } from 'node:child_process';
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
    try {
      const size = (await input.stat()).size;
      const position = Math.max(startedAt, size - 256 * 1024);
      const bytes = Buffer.alloc(Math.max(0, size - position));
      const read = await input.read(bytes, 0, bytes.length, position);
      const raw = bytes.subarray(0, read.bytesRead).toString('utf8');
      codes = [...new Set([
        ...[...raw.matchAll(/\berror\s+(TS\d{4,5})\b/g)].map(match => match[1]),
        ...[...raw.matchAll(/\berror\[(E\d{4})\]/g)].map(match => match[1]),
      ])].sort().slice(0, 32);
    } finally { await input.close(); }
    const code = Number.isInteger(result.code) && result.code >= 0 && result.code <= 255 ? result.code : 'none';
    const signal = /^SIG[A-Z0-9]{1,16}$/.test(result.signal ?? '') ? result.signal : 'none';
    console.error(`CI_TASK_DIAGNOSTICS exit_code=${code} signal=${signal} compiler_codes=${codes.join(',') || 'none'}`);
    process.exitCode = 1;
  }
  else console.log('CI_TASK_PASSED_' + task.toUpperCase().replaceAll('-', '_'));
} finally { await output.close(); }
