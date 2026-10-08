/**
 * One-release bounded recovery for the failed 2026-10-08 gateway-only build.
 * No new release, upload or deployment is created until immutable identity
 * and the existing server-side draft/upload have been reconciled.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm, open, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { identity } from './assets.mjs';

export const PLAN = Object.freeze({
  originalRun: 37800222913,
  source: '647d11431d947c6d3b81798173eb1b3ddb3419fe',
  release: 'bbb10039-ab8b-4273-b3e9-85ce79e87c04',
  upload: 'f67afe3b-5bb5-416e-b372-2a8c9fd4647f',
  version: '0.3.7',
  filename: 'CodeFerry-gateway-0.3.7-linux-x64.tar.gz',
  size: 56216492,
  sha256: 'f0673bae04749b608eed6e35fb807ed8e7132b651c195fbf8334036dc98d43ed',
  chunkSize: 16 * 1024 * 1024,
});

export function validateUpload(upload, now = Date.now()) {
  assert.equal(upload?.id, PLAN.upload);
  assert.equal(upload?.releaseId, PLAN.release);
  assert.equal(upload?.status, 'active');
  assert.equal(upload?.size, PLAN.size);
  assert.equal(upload?.chunkSize, PLAN.chunkSize);
  assert.equal(upload?.chunkCount, Math.ceil(PLAN.size / PLAN.chunkSize));
  assert.ok(upload.expiresAt > now, 'UPLOAD_EXPIRED_STOP_NO_REPLAY');
  assert.ok(Array.isArray(upload.received));
  assert.ok(upload.received.every(n => Number.isInteger(n) && n >= 0 && n < upload.chunkCount));
  assert.equal(new Set(upload.received).size, upload.received.length);
  return Array.from({ length: upload.chunkCount }, (_, i) => i).filter(i => !upload.received.includes(i));
}

function gh(path) {
  return JSON.parse(execFileSync('gh', ['api', path], {
    encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  }));
}

async function run() {
  const key = process.env.CODEFERRY_PUBLISH_KEY;
  assert.match(key ?? '', /^cfr_publish_[A-Za-z0-9_-]{8,500}$/);
  const run = gh('repos/crazylin/codeferry-build/actions/runs/' + PLAN.originalRun);
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'failure');
  const jobs = gh('repos/crazylin/codeferry-build/actions/runs/' + PLAN.originalRun + '/jobs?per_page=100').jobs;
  for (const name of ['Resolve one immutable private source commit',
    'Contracts and real PostgreSQL Redis validation',
    'Create one private immutable build draft',
    'Embedded gateway Docker image linux amd64']) {
    assert.equal(jobs.filter(job => job.name === name && job.conclusion === 'success').length, 1);
  }
  assert.equal(jobs.filter(job => job.name === 'Publish verified release set and update gateway' && job.conclusion === 'failure').length, 1);
  assert.equal(gh('repos/crazylin/codeferry').private, true);
  assert.equal(execFileSync('git', ['-C', resolve('source'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), PLAN.source);

  const meta = JSON.parse(await readFile(join(process.env.ASSET_DIR, PLAN.filename + '.metadata.json'), 'utf8'));
  const file = join(process.env.ASSET_DIR, PLAN.filename);
  const fileStat = await stat(file);
  assert.ok(fileStat.isFile());
  for (const field of ['size', 'sha256', 'filename', 'version']) assert.equal(meta[field], PLAN[field]);
  assert.equal(meta.sourceCommit, PLAN.source);
  assert.equal(meta.component, 'gateway');
  assert.equal(meta.channel, 'stable');
  assert.equal(meta.platform, 'linux');
  assert.equal(meta.arch, 'x64');
  assert.equal(meta.format, 'tar.gz');
  assert.equal(meta.clientEngine, 'native');
  const measured = await identity(file);
  assert.equal(measured.size, PLAN.size);
  assert.equal(measured.sha256, PLAN.sha256);

  const journalFile = join(process.env.RUNNER_TEMP, 'gateway-037-recovery-journal.json');
  const journal = { schema: 1, originalRun: PLAN.originalRun, source: PLAN.source, release: PLAN.release, upload: PLAN.upload, events: [] };
  async function record(event, extra = {}) {
    journal.events.push({ event, at: new Date().toISOString(), ...extra });
    await writeFile(journalFile, JSON.stringify(journal, null, 2), { mode: 0o600 });
    console.log('RECOVERY_EVENT_' + event);
  }

  async function jsonResponse(response) {
    const text = await response.text();
    assert.ok(text.length <= 262144, 'RESPONSE_TOO_LARGE');
    const json = JSON.parse(text);
    if (!response.ok) throw Error('REMOTE_HTTP_' + response.status + '_' + (/^[A-Z_0-9]{1,80}$/.test(json.error ?? '') ? json.error : 'ERROR'));
    return json;
  }

  async function api(path, method, body, extraHeaders = {}) {
    assert.match(path, /^\/api\/(?:uploads|releases|deployments)\//);
    const opts = { method, redirect: 'error', signal: AbortSignal.timeout(120000),
      headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', ...extraHeaders } };
    if (method !== 'GET') opts.body = JSON.stringify(body ?? {});
    await record('REQUEST_' + method);
    let response;
    try { response = await fetch('https://codeferry.link' + path, opts); }
    catch { await record('TRANSPORT_UNKNOWN_' + method); throw Error('TRANSPORT_UNKNOWN_NO_POST_REPLAY'); }
    const parsed = await jsonResponse(response);
    await record('RESPONSE_' + method, { status: response.status });
    return parsed;
  }

  const response = await api('/api/uploads/' + PLAN.upload, 'GET');
  const missing = validateUpload(response.upload);
  await record('ARTIFACT_AND_EXISTING_UPLOAD_VERIFIED', { missingChunks: missing.length });
  const work = await mkdtemp(join(tmpdir(), 'cf-gateway-037-'));
  try {
    const handle = await open(file, 'r');
    try {
      for (const index of missing) {
        const offset = index * PLAN.chunkSize;
        const length = Math.min(PLAN.chunkSize, PLAN.size - offset);
        const bytes = Buffer.allocUnsafe(length);
        let filled = 0;
        while (filled < length) {
          const { bytesRead } = await handle.read(bytes, filled, length - filled, offset + filled);
          assert.ok(bytesRead > 0);
          filled += bytesRead;
        }
        const chunkFile = join(work, 'chunk-' + index);
        const responseFile = join(work, 'response-' + index);
        await writeFile(chunkFile, bytes, { mode: 0o600 });
        const hash = createHash('sha256').update(bytes).digest('hex');
        await record('CHUNK_PUT_START', { index, size: length });
        // Use HTTP/1.1 curl to avoid the hanging Node fetch transport observed
        // in the original run. Pass the secret only over stdin config, not argv.
        const args = ['-q', '--config', '-', '--http1.1', '--silent', '--show-error',
          '--connect-timeout', '15', '--max-time', '180', '--max-redirs', '0',
          '--request', 'PUT', '--header', 'Expect:',
          '--header', 'Content-Type: application/octet-stream',
          '--header', 'X-Chunk-SHA256: ' + hash,
          '--data-binary', '@' + chunkFile, '--output', responseFile,
          '--write-out', '%{http_code}',
          'https://codeferry.link/api/uploads/' + PLAN.upload + '/chunks/' + index];
        const result = await new Promise((res, rej) => {
          const child = spawn('curl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
          let out = ''; let err = '';
          child.stdout.on('data', b => { if ((out += b.toString()).length > 1000) child.kill(); });
          child.stderr.on('data', b => { if ((err += b.toString()).length > 2000) child.kill(); });
          child.on('error', rej);
          child.on('close', code => res({ code, out, err }));
          child.stdin.end('header = "Authorization: Bearer ' + key + '"\n');
        });
        if (result.code !== 0) {
          await record('CHUNK_TRANSPORT_FAILED', { index, curlCode: result.code });
          throw Error('CHUNK_TRANSPORT_FAILED_NO_BLIND_RETRY');
        }
        const http = Number(result.out.trim());
        assert.equal(http, 200, 'CHUNK_HTTP_' + http);
        await record('CHUNK_PUT_OK', { index });
        await rm(chunkFile, { force: true });
        await rm(responseFile, { force: true });
      }
    } finally { await handle.close(); }
  } finally { await rm(work, { recursive: true, force: true }); }

  const after = (await api('/api/uploads/' + PLAN.upload, 'GET')).upload;
  assert.equal(validateUpload(after).length, 0);
  await record('ALL_CHUNKS_VERIFIED');
  const complete = (await api('/api/uploads/' + PLAN.upload + '/complete', 'POST', {})).release;
  assert.equal(complete.id, PLAN.release);
  assert.equal(complete.size, PLAN.size);
  assert.equal(complete.sha256, PLAN.sha256);
  await record('RELEASE_COMPLETE');
  const publish = (await api('/api/releases/' + PLAN.release + '/publish', 'POST', {})).release;
  assert.equal(publish.id, PLAN.release);
  assert.equal(publish.status, 'published');
  assert.equal(publish.sha256, PLAN.sha256);
  await record('RELEASE_PUBLISHED');
  if (process.env.DEFER_GATEWAY_DEPLOYMENT === 'true') {
    await record('DEPLOYMENT_DEFERRED_PENDING_MIGRATION_REVIEW');
    console.log('GATEWAY_037_PUBLISHED_NO_DEPLOYMENT_REQUEST');
    return;
  }

  // Only one deployment POST; a lost response is an uncertain outcome.
  const deployment = (await api('/api/releases/' + PLAN.release + '/deploy', 'POST', {},
    { 'idempotency-key': 'gateway037-recover-build37800222913' })).deployment;
  assert.match(deployment?.id ?? '', /^[a-f0-9-]{36}$/);
  await record('DEPLOYMENT_SUBMITTED', { deploymentId: deployment.id });
  const deadline = Date.now() + 45 * 60 * 1000;
  for (;;) {
    assert.ok(Date.now() < deadline, 'DEPLOYMENT_POLL_TIMEOUT_NO_REPLAY');
    await new Promise(resolve => setTimeout(resolve, 3000));
    let value;
    try { value = (await api('/api/deployments/' + deployment.id, 'GET')).deployment; }
    catch { continue; } // read-only poll may be interrupted by Gateway restart
    assert.equal(value.id, deployment.id);
    if (value.status === 'succeeded') break;
    if (value.status === 'failed' || value.status === 'outcome_unknown') {
      await record('DEPLOYMENT_' + value.status.toUpperCase());
      throw Error('DEPLOYMENT_' + value.status.toUpperCase() + '_NO_REPLAY');
    }
    assert.ok(['pending', 'running'].includes(value.status));
  }
  await record('DEPLOYMENT_SUCCEEDED');
  console.log('GATEWAY_037_VERIFIED_DEPLOYMENT_SUCCEEDED');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch(e => { console.error('GATEWAY_037_RECOVERY_BLOCKED_' + String(e.message).replace(/[^A-Z0-9_]/gi, '_').slice(0, 90)); process.exitCode = 1; });
}
