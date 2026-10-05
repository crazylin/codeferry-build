import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const tag = (await readFile(join(process.env.RUNNER_TEMP, 'gateway-tag'), 'utf8')).trim();
const name = 'codeferry-ci-smoke';
let started = false;
try {
  execFileSync('docker', ['run', '--detach', '--name', name, '--network', 'host', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--tmpfs', '/var/lib/codeferry:rw,size=512m,mode=0700,uid=10001,gid=10001',
    '--tmpfs', '/tmp:rw,size=64m,mode=1777', '-e', 'DATABASE_URL=postgres://codeferry:fixture-ci-password@127.0.0.1:5432/codeferry',
    '-e', 'REDIS_URL=redis://127.0.0.1:6379', '-e', 'REMOTEMCP_BOOTSTRAP_TOKEN=fixture-ci-bootstrap-credential-32bytes',
    '-e', 'REMOTEMCP_PUBLIC_ORIGIN=http://127.0.0.1:18790', '-e', 'REMOTEMCP_BIND_ADDR=127.0.0.1:18790',
    '-e', 'REMOTEMCP_NATIVE_ORIGIN=http://127.0.0.1:18788', '-e', 'REMOTEMCP_DATA=/var/lib/codeferry',
    '-e', 'REMOTEMCP_PUBLIC_DIR=/app/public', tag], { stdio: 'pipe' });
  started = true;
  const deadline = Date.now() + 45_000; let ready = false;
  while (Date.now() < deadline) {
    if (execFileSync('docker', ['inspect', '--format', '{{.State.Running}}', name], { encoding: 'utf8' }).trim() !== 'true') throw Error('GATEWAY_IMAGE_EXITED');
    try {
      const response = await fetch('http://127.0.0.1:18790/healthz', { signal: AbortSignal.timeout(1500) });
      const body = await response.json();
      if (response.ok && body.product === 'CodeFerry' && body.status === 'ok') { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready) throw Error('GATEWAY_IMAGE_NOT_READY');
  const native = await fetch('http://127.0.0.1:18790/native/healthz', { signal: AbortSignal.timeout(5000) });
  if (!native.ok) throw Error('GATEWAY_IMAGE_NATIVE_NOT_READY');
  const website = await fetch('http://127.0.0.1:18790/', { signal: AbortSignal.timeout(5000) });
  if (!website.ok || !(await website.text()).includes('CodeFerry')) throw Error('GATEWAY_IMAGE_WEBSITE_NOT_READY');
  execFileSync('docker', ['stop', '--time', '330', name], { stdio: 'pipe', timeout: 335_000 });
  const state = JSON.parse(execFileSync('docker', ['inspect', name], { encoding: 'utf8' }))[0].State;
  if (state.Running || state.ExitCode !== 0) throw Error('GATEWAY_IMAGE_DRAIN_FAILED');
  console.log('GATEWAY_IMAGE_LINUX_EMBEDDED_STARTUP_AND_DRAIN_PASSED');
} finally {
  if (started) execFileSync('docker', ['rm', '--force', name], { stdio: 'pipe' });
}
