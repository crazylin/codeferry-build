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
const output = await open(join(logs, task + '.log'), 'a', 0o600);
try {
  const child = spawn(command[0], command.slice(1), { stdio: ['ignore', output.fd, output.fd],
    shell: process.platform === 'win32' && /^(npm|npx)$/.test(command[0]) });
  const code = await new Promise(resolve => {
    child.once('error', () => resolve(1));
    child.once('exit', code => resolve(code ?? 1));
  });
  if (code !== 0) { console.error('CI_TASK_FAILED_' + task.toUpperCase().replaceAll('-', '_')); process.exitCode = 1; }
  else console.log('CI_TASK_PASSED_' + task.toUpperCase().replaceAll('-', '_'));
} finally { await output.close(); }
