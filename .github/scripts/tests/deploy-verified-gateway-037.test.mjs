import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAN, verifyMetadata, verifyBeforeDeployHealth, readBoundedJson, safeDeploymentErrorCode, safeApiErrorCode, pollDeployment } from '../deploy-verified-gateway-037.mjs';
const meta = () => ({
  version:PLAN.version,filename:PLAN.filename,size:PLAN.size,
  sha256:PLAN.sha256,component:'gateway',platform:'linux',arch:'x64',
  format:'tar.gz',channel:'stable',clientEngine:'native',
  sourceCommit:PLAN.source,
});
test('exact published release metadata passes',()=>assert.doesNotThrow(()=>verifyMetadata(meta())));
test('modified version, sha or source fails closed',()=>{
  for(const [field,value] of [['version','0.3.8'],['sha256','invalid'],['sourceCommit','other'],['size',1]])
    assert.throws(()=>verifyMetadata({...meta(),[field]:value}));
});
test('only reviewed current versions or the already active exact target pass pre-deploy health', () => {
  for (const version of ['0.3.4', '0.3.5']) assert.equal(verifyBeforeDeployHealth({ status: 'ok', version }), false);
  assert.equal(verifyBeforeDeployHealth({ status: 'ok', version: PLAN.version }), true);
  for (const version of ['0.3.6', '0.4.0', '', undefined]) {
    assert.throws(() => verifyBeforeDeployHealth({ status: 'ok', version }), { message: 'PRODUCTION_VERSION_CHANGED_NO_DEPLOY' });
  }
  assert.throws(() => verifyBeforeDeployHealth({ status: 'error', version: '0.3.5' }), { message: 'PRODUCTION_UNHEALTHY_NO_DEPLOY' });
});

const deploymentId = '01234567-89ab-4cde-8fab-0123456789ab';
const privateText = 'cfr_publish_private_fixture_never_log';
test('bounded JSON decoding preserves UTF-8 across chunk boundaries and rejects invalid UTF-8', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ value: '中文😀' }));
  const response = new Response(new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  }));
  assert.deepEqual(await readBoundedJson(response), { value: '中文😀' });
  const invalid = new Response(Uint8Array.from([123, 34, 120, 34, 58, 34, 0xc3, 0x28, 34, 125]));
  await assert.rejects(readBoundedJson(invalid), { message: 'REMOTE_RESPONSE_INVALID' });
});

test('response limit counts bytes rather than decoded characters and rejects at 262144 bytes', async () => {
  const below = JSON.stringify({ x: 'A'.repeat(262135) });
  assert.equal(new TextEncoder().encode(below).byteLength, 262143);
  assert.equal((await readBoundedJson(new Response(below))).x.length, 262135);
  for (const body of [JSON.stringify({ x: 'A'.repeat(262136) }), JSON.stringify({ x: '€'.repeat(90000) })]) {
    assert.ok(body.length <= 262144);
    await assert.rejects(readBoundedJson(new Response(body)), { message: 'REMOTE_RESPONSE_INVALID' });
  }
});

function pollingFixture(responses, deadline = 20000) {
  let clock = 0;
  const events = [], reads = [];
  return {
    events, reads,
    run: () => pollDeployment({
      id: deploymentId, deadline, now: () => clock,
      sleep: async ms => { clock += ms; },
      note: async (event, extra = {}) => { events.push({ event, ...extra }); },
      readDeployment: async timeoutMs => {
        reads.push(timeoutMs);
        const response = responses[Math.min(reads.length - 1, responses.length - 1)];
        if (response instanceof Error) throw response;
        return response;
      },
    }),
  };
}

test('known fixed failure codes pass; arbitrary, oversized and non-string values are redacted', () => {
  assert.equal(safeDeploymentErrorCode('DEPLOY_MIGRATION_REVIEW_REQUIRED'), 'DEPLOY_MIGRATION_REVIEW_REQUIRED');
  assert.equal(safeDeploymentErrorCode('DEPLOY_WORKER_INTERRUPTED'), 'DEPLOY_WORKER_INTERRUPTED');
  for (const value of [null, undefined, {}, ['DEPLOY_MIGRATION_REVIEW_REQUIRED'],
    'DEPLOY_' + privateText.toUpperCase(), 'DEPLOY_' + 'A'.repeat(262144), privateText]) {
    assert.equal(safeDeploymentErrorCode(value), 'DEPLOY_ERROR_UNRECOGNIZED');
    assert.equal(safeApiErrorCode(value), 'REJECTED');
  }
  assert.equal(safeApiErrorCode('DEPLOYMENT_REQUIRES_RESOLUTION'), 'DEPLOYMENT_REQUIRES_RESOLUTION');
  assert.equal(safeApiErrorCode('RELEASE_' + privateText.toUpperCase()), 'REJECTED');
});

test('migration review failure keeps the exact safe code in journal and terminal error', async () => {
  const fixture = pollingFixture([{ id: deploymentId, status: 'failed', errorCode: 'DEPLOY_MIGRATION_REVIEW_REQUIRED' }]);
  await assert.rejects(fixture.run(), { message: 'WORKER_FAILED_DEPLOY_MIGRATION_REVIEW_REQUIRED_NO_REPLAY' });
  assert.deepEqual(fixture.events, [{ event: 'DEPLOYMENT_FAILED', errorCode: 'DEPLOY_MIGRATION_REVIEW_REQUIRED' }]);
  assert.equal(fixture.reads.length, 1);
});

test('uncertain worker outcome is retained and never polled or resubmitted again', async () => {
  const fixture = pollingFixture([{ id: deploymentId, status: 'outcome_unknown', errorCode: 'DEPLOY_WORKER_INTERRUPTED' }]);
  await assert.rejects(fixture.run(), { message: 'WORKER_OUTCOME_UNKNOWN_DEPLOY_WORKER_INTERRUPTED_NO_REPLAY' });
  assert.deepEqual(fixture.events, [{ event: 'DEPLOYMENT_OUTCOME_UNKNOWN', errorCode: 'DEPLOY_WORKER_INTERRUPTED' }]);
  assert.equal(fixture.reads.length, 1);
});

test('unrecognized terminal error details never reach journal or error', async () => {
  const fixture = pollingFixture([{ id: deploymentId, status: 'failed', errorCode: 'DEPLOY_' + privateText.toUpperCase() }]);
  await assert.rejects(fixture.run(), { message: 'WORKER_FAILED_DEPLOY_ERROR_UNRECOGNIZED_NO_REPLAY' });
  assert.deepEqual(fixture.events, [{ event: 'DEPLOYMENT_FAILED', errorCode: 'DEPLOY_ERROR_UNRECOGNIZED' }]);
});

test('transient read-only polling failure retries the same job and permits success', async () => {
  const fixture = pollingFixture([
    new Error('REMOTE_HTTP_503_INTERNAL_ERROR'),
    { id: deploymentId, status: 'running' },
    { id: deploymentId, status: 'succeeded' },
  ]);
  await fixture.run();
  assert.equal(fixture.reads.length, 3);
  assert.deepEqual(fixture.events, [{ event: 'POLL_READ_FAILED', errorCode: 'REMOTE_HTTP_503_INTERNAL_ERROR' }]);
});

test('persistent polling failure reaches its deadline with the last fixed safe code', async () => {
  const fixture = pollingFixture([new Error('REMOTE_HTTP_403_RELEASE_SCOPE_REQUIRED')], 10000);
  await assert.rejects(fixture.run(), { message: 'POLL_TIMEOUT_REMOTE_HTTP_403_RELEASE_SCOPE_REQUIRED_NO_REPLAY' });
  assert.equal(fixture.reads.length, 3);
  assert.deepEqual(fixture.reads, [7000, 4000, 1000]);
  assert.deepEqual(fixture.events.at(-1), { event: 'POLL_TIMEOUT', errorCode: 'REMOTE_HTTP_403_RELEASE_SCOPE_REQUIRED' });
});

test('untrusted transport messages are redacted while retries remain deadline bounded', async () => {
  for (const value of [privateText, 'REMOTE_HTTP_503_RELEASE_' + privateText.toUpperCase()]) {
    const fixture = pollingFixture([new Error(value)], 4000);
    await assert.rejects(fixture.run(), { message: 'POLL_TIMEOUT_POLL_READ_UNAVAILABLE_NO_REPLAY' });
    assert.equal(fixture.reads.length, 1);
    assert.equal(JSON.stringify(fixture.events).includes(privateText), false);
    assert.deepEqual(fixture.events.at(-1), { event: 'POLL_TIMEOUT', errorCode: 'POLL_READ_UNAVAILABLE' });
  }
});

test('deadline does not start a new read and invalid job identity fails without remote text', async () => {
  const expired = pollingFixture([], 3000);
  await assert.rejects(expired.run(), { message: 'POLL_TIMEOUT_NO_REPLAY' });
  assert.equal(expired.reads.length, 0);
  const changed = pollingFixture([{ id: privateText, status: 'succeeded' }]);
  await assert.rejects(changed.run(), { message: 'DEPLOYMENT_ID_MISMATCH' });
  assert.equal(changed.reads.length, 1);
  const invalid = pollingFixture([{ id: deploymentId, status: privateText }]);
  await assert.rejects(invalid.run(), { message: 'DEPLOYMENT_STATUS_INVALID' });
});

async function runCliFixture(mode) {
  const work = await mkdtemp(join(tmpdir(), 'cf-deploy037-test-'));
  try {
    await writeFile(join(work, PLAN.filename + '.metadata.json'), JSON.stringify(meta()));
    const immutable = { id: 406985511, draft: false, tag_name: 'build-37800222913-1',
      target_commitish: PLAN.source, assets: [{ name: PLAN.filename, size: PLAN.size },
        { name: PLAN.filename + '.metadata.json', size: 1 }] };
    await writeFile(join(work, 'gh'), '#!' + process.execPath + '\nprocess.stdout.write(' + JSON.stringify(JSON.stringify(immutable)) + ');\n', { mode: 0o700 });
    const preload = `
      import { appendFileSync } from 'node:fs';
      const mode = ${JSON.stringify(mode)}, id = ${JSON.stringify(deploymentId)}, privateText = ${JSON.stringify(privateText)};
      globalThis.setTimeout = callback => { queueMicrotask(callback); return 0; };
      globalThis.fetch = async (url, opts = {}) => {
        appendFileSync(${JSON.stringify(join(work, 'calls.jsonl'))}, JSON.stringify({ path: new URL(url).pathname, method: opts.method ?? 'GET' }) + '\\n');
        if (url.endsWith('/healthz')) return Response.json({ status: 'ok', version:
          mode === 'worker-failed-before-035' ? '0.3.5' :
          mode === 'rejected-036' ? '0.3.6' : mode === 'rejected-other' ? '0.4.0' :
          mode === 'already-target' ? '0.3.7' : '0.3.4' });
        if (opts.method === 'POST') {
          if (mode === 'lost-post') throw Error(privateText);
          if (mode === 'invalid-post-body') return new Response('INVALID_' + privateText, { status: 200 });
          if (mode === 'invalid-post-id') return Response.json({ deployment: { id: privateText } });
          if (mode === 'oversized-post-body') {
            let chunks = 0;
            return new Response(new ReadableStream({
              pull(controller) {
                chunks++;
                controller.enqueue(new TextEncoder().encode(privateText.padEnd(16384, 'X')));
              },
              cancel() {
                appendFileSync(${JSON.stringify(join(work, 'stream.json'))}, JSON.stringify({ cancelled: true, chunks }));
              },
            }, { highWaterMark: 0 }), { status: 200 });
          }
          return Response.json({ deployment: { id } });
        }
        return Response.json({ deployment: { id, status: 'failed', errorCode: 'DEPLOY_MIGRATION_REVIEW_REQUIRED' } });
      };
    `;
    await writeFile(join(work, 'preload.mjs'), preload);
    const script = fileURLToPath(new URL('../deploy-verified-gateway-037.mjs', import.meta.url));
    let output, exitCode;
    try {
      const result = await promisify(execFile)(process.execPath, ['--import', join(work, 'preload.mjs'), script], {
        env: { ...process.env, PATH: work + delimiter + process.env.PATH,
          CODEFERRY_PUBLISH_KEY: 'cfr_publish_fixture_037', ASSET_DIR: work, RUNNER_TEMP: work },
        timeout: 10000, maxBuffer: 1048576,
      });
      exitCode = 0;
      output = result.stdout + result.stderr;
    } catch (error) {
      assert.equal(error.code, 1);
      exitCode = error.code;
      output = error.stdout + error.stderr;
    }
    const journalText = await readFile(join(work, 'gateway-037-deployment-journal.json'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return 'null';
      throw error;
    });
    const journal = JSON.parse(journalText);
    const calls = (await readFile(join(work, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    const stream = await readFile(join(work, 'stream.json'), 'utf8').then(JSON.parse).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    return { output, exitCode, journal, calls, stream };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

test('CLI journals and reports the worker migration failure after exactly one POST', async () => {
  for (const mode of ['worker-failed', 'worker-failed-before-035']) {
    const { output, exitCode, journal, calls } = await runCliFixture(mode);
    assert.equal(exitCode, 1);
    assert.match(output, /GATEWAY037_DEPLOYMENT_BLOCKED_WORKER_FAILED_DEPLOY_MIGRATION_REVIEW_REQUIRED_NO_REPLAY/);
    assert.deepEqual(journal.events.at(-1).errorCode, 'DEPLOY_MIGRATION_REVIEW_REQUIRED');
    assert.deepEqual(calls.filter(c => c.method === 'POST'), [{ path: '/api/releases/' + PLAN.release + '/deploy', method: 'POST' }]);
    assert.deepEqual(calls.at(-1), { path: '/api/deployments/' + deploymentId, method: 'GET' });
  }
});

test('CLI rejects unreviewed live versions before POST and exits early for the exact target', async () => {
  for (const mode of ['rejected-036', 'rejected-other']) {
    const { output, exitCode, calls } = await runCliFixture(mode);
    assert.equal(exitCode, 1);
    assert.match(output, /GATEWAY037_DEPLOYMENT_BLOCKED_PRODUCTION_VERSION_CHANGED_NO_DEPLOY/);
    assert.deepEqual(calls, [{ path: '/healthz', method: 'GET' }]);
  }
  const { output, exitCode, journal, calls } = await runCliFixture('already-target');
  assert.equal(exitCode, 0);
  assert.match(output, /GATEWAY037_ALREADY_DEPLOYED/);
  assert.equal(journal.events.at(-1).event, 'ALREADY_DEPLOYED');
  assert.deepEqual(calls, [{ path: '/healthz', method: 'GET' }]);
});

test('lost or malformed deployment POST response stops once and retains an uncertain outcome', async () => {
  for (const mode of ['lost-post', 'invalid-post-body', 'invalid-post-id']) {
    const { output, exitCode, journal, calls } = await runCliFixture(mode);
    assert.equal(exitCode, 1);
    assert.match(output, /GATEWAY037_DEPLOYMENT_BLOCKED_(?:NO_NON_IDEMPOTENT_REPLAY|DEPLOYMENT_RESPONSE_INVALID_NO_REPLAY)/);
    assert.equal(output.includes(privateText), false);
    assert.equal(JSON.stringify(journal).includes(privateText), false);
    assert.equal(journal.events.at(-1).event, 'OUTCOME_UNKNOWN_POST');
    assert.equal(calls.filter(c => c.method === 'POST').length, 1);
    assert.equal(calls.some(c => c.path.startsWith('/api/deployments/')), false);
  }
});

test('CLI cancels an oversized deployment POST stream at the byte limit and never replays it', async () => {
  const { output, exitCode, journal, calls, stream } = await runCliFixture('oversized-post-body');
  assert.equal(exitCode, 1);
  assert.match(output, /GATEWAY037_DEPLOYMENT_BLOCKED_NO_NON_IDEMPOTENT_REPLAY/);
  assert.deepEqual(stream, { cancelled: true, chunks: 16 });
  assert.equal(output.includes(privateText), false);
  assert.equal(JSON.stringify(journal).includes(privateText), false);
  assert.equal(journal.events.at(-1).event, 'OUTCOME_UNKNOWN_POST');
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
  assert.equal(calls.some(c => c.path.startsWith('/api/deployments/')), false);
});
