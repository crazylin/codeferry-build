/** Deploy only the already-published, immutable 0.3.7 gateway. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PLAN = Object.freeze({
  release: 'bbb10039-ab8b-4273-b3e9-85ce79e87c04',
  source: '647d11431d947c6d3b81798173eb1b3ddb3419fe',
  version: '0.3.7',
  filename: 'CodeFerry-gateway-0.3.7-linux-x64.tar.gz',
  size: 56216492,
  sha256: 'f0673bae04749b608eed6e35fb807ed8e7132b651c195fbf8334036dc98d43ed',
  idempotencyKey: 'gateway037-reviewed-db-migration-20261009',
});
export function verifyMetadata(m) {
  for (const key of ['version','filename','size','sha256']) assert.equal(m[key], PLAN[key]);
  assert.equal(m.component,'gateway');
  assert.equal(m.platform,'linux');
  assert.equal(m.arch,'x64');
  assert.equal(m.format,'tar.gz');
  assert.equal(m.channel,'stable');
  assert.equal(m.clientEngine,'native');
  assert.equal(m.sourceCommit,PLAN.source);
}
export function verifyBeforeDeployHealth(health) {
  if (health?.status !== 'ok') throw Error('PRODUCTION_UNHEALTHY_NO_DEPLOY');
  if (health.version === PLAN.version) return true;
  // 0.3.5 is the reviewed schema-compatible intermediate image.
  if (!['0.3.4', '0.3.5'].includes(health.version)) throw Error('PRODUCTION_VERSION_CHANGED_NO_DEPLOY');
  return false;
}

export async function readBoundedJson(response) {
  let reader;
  try {
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0, text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || value.byteLength >= 262144 - bytes) {
        throw Error('REMOTE_RESPONSE_INVALID');
      }
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const json = JSON.parse(text);
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw Error('REMOTE_RESPONSE_INVALID');
    return json;
  } catch {
    if (reader) await reader.cancel().catch(() => {});
    throw Error('REMOTE_RESPONSE_INVALID');
  } finally {
    if (reader) reader.releaseLock();
  }
}

// Only fixed protocol codes may enter the journal/log. A prefix-shaped value
// could still contain private data, so do not pass arbitrary DEPLOY_* text.
const deploymentErrorCodes = new Set([
  'DEPLOY_ARCHIVE_INVALID', 'DEPLOY_ARCHIVE_TOO_LARGE',
  'DEPLOY_ARTIFACT_CHANGED', 'DEPLOY_ARTIFACT_INVALID', 'DEPLOY_ARTIFACT_UNAVAILABLE',
  'DEPLOY_BACKUP_CHANGED', 'DEPLOY_BACKUP_COMMAND_FAILED', 'DEPLOY_BACKUP_CONFIG_INVALID',
  'DEPLOY_BACKUP_DISK_SPACE', 'DEPLOY_BACKUP_EXPOSED', 'DEPLOY_BACKUP_FAILED',
  'DEPLOY_BACKUP_IMAGE_MISMATCH', 'DEPLOY_BACKUP_INVALID', 'DEPLOY_BACKUP_OUTCOME_UNKNOWN',
  'DEPLOY_BACKUP_PATH_INVALID', 'DEPLOY_BACKUP_RETENTION_PENDING', 'DEPLOY_BACKUP_SQLITE_INVALID',
  'DEPLOY_BACKUP_TIMEOUT', 'DEPLOY_BACKUP_TOO_LARGE',
  'DEPLOY_COMMAND_FAILED', 'DEPLOY_COMMAND_OUTCOME_UNKNOWN',
  'DEPLOY_COMPOSE_INVALID', 'DEPLOY_COMPOSE_REVIEW_REQUIRED', 'DEPLOY_CONTAINER_STATE_UNKNOWN',
  'DEPLOY_CURRENT_GATEWAY_UNHEALTHY', 'DEPLOY_DATABASE_RESPONSE_INVALID',
  'DEPLOY_FILE_OPERATION_FAILED', 'DEPLOY_HEALTH_CHECK_FAILED',
  'DEPLOY_IMAGE_IDENTITY_INVALID', 'DEPLOY_IMAGE_TAG_INVALID', 'DEPLOY_INVALID_ID', 'DEPLOY_INVALID_STATUS',
  'DEPLOY_KEY_REVOKED', 'DEPLOY_MIGRATION_REVIEW_REQUIRED', 'DEPLOY_MOUNTS_CHANGED',
  'DEPLOY_RECONCILE_STATUS_INVALID', 'DEPLOY_RECONCILE_UNCONFIRMED',
  'DEPLOY_ROLLBACK_FAILED', 'DEPLOY_ROLLBACK_OUTCOME_UNKNOWN', 'DEPLOY_VERIFIED_NOT_ACTIVE',
  'DEPLOY_WORKER_ALREADY_RUNNING', 'DEPLOY_WORKER_INTERRUPTED',
  'DEPLOY_WORKER_OUTCOME_UNKNOWN', 'DEPLOY_WORKER_POLL_FAILED',
]);
const apiErrorCodes = new Set([
  'UNAUTHORIZED', 'INTERNAL_ERROR', 'INVALID_RELEASE_INPUT',
  'RELEASE_KEY_REJECTED', 'RELEASE_SCOPE_REQUIRED', 'RELEASE_NOT_FOUND',
  'GATEWAY_RELEASE_REQUIRED', 'DEPLOY_IDEMPOTENCY_CONFLICT',
  'DEPLOYMENT_REQUIRES_RESOLUTION', 'DEPLOYMENT_NOT_FOUND',
]);
export function safeDeploymentErrorCode(value) {
  return typeof value === 'string' && value.length <= 86 && deploymentErrorCodes.has(value)
    ? value : 'DEPLOY_ERROR_UNRECOGNIZED';
}
export function safeApiErrorCode(value) {
  return typeof value === 'string' && value.length <= 80 && apiErrorCodes.has(value)
    ? value : 'REJECTED';
}
function safePollErrorCode(error) {
  if (error?.message === 'POLL_READ_UNAVAILABLE') return error.message;
  const match = typeof error?.message === 'string' && error.message.length <= 110
    ? /^REMOTE_HTTP_([1-5][0-9]{2})_([A-Z_0-9]{1,80})$/.exec(error.message) : null;
  return match && (match[2] === 'REJECTED' || apiErrorCodes.has(match[2]))
    ? error.message : 'POLL_READ_UNAVAILABLE';
}

export async function pollDeployment({
  id, readDeployment, note,
  deadline = Date.now() + 45 * 60 * 1000,
  now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  let lastReadError;
  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      await note('POLL_TIMEOUT', lastReadError ? { errorCode: lastReadError } : {});
      throw Error('POLL_TIMEOUT_' + (lastReadError ? lastReadError + '_' : '') + 'NO_REPLAY');
    }
    await sleep(Math.min(3000, remaining));
    if (now() >= deadline) continue;
    let dep;
    try {
      dep = await readDeployment(Math.min(90000, deadline - now()));
    } catch (error) {
      lastReadError = safePollErrorCode(error);
      await note('POLL_READ_FAILED', { errorCode: lastReadError });
      continue; // Only the already-submitted job is read; never resubmit it.
    }
    if (dep?.id !== id) throw Error('DEPLOYMENT_ID_MISMATCH');
    if (dep.status === 'succeeded') return;
    if (dep.status === 'failed' || dep.status === 'outcome_unknown') {
      const errorCode = safeDeploymentErrorCode(dep.errorCode);
      await note('DEPLOYMENT_' + dep.status.toUpperCase(), { errorCode });
      throw Error('WORKER_' + dep.status.toUpperCase() + '_' + errorCode + '_NO_REPLAY');
    }
    if (!['pending', 'running'].includes(dep.status)) throw Error('DEPLOYMENT_STATUS_INVALID');
  }
}

async function main() {
  const key=process.env.CODEFERRY_PUBLISH_KEY;
  if(typeof key!=='string'||!/^cfr_publish_[A-Za-z0-9_-]{8,500}$/.test(key))throw Error('PUBLISH_KEY_INVALID');
  const meta=JSON.parse(await readFile(join(process.env.ASSET_DIR,PLAN.filename+'.metadata.json'),'utf8'));
  verifyMetadata(meta);
  const immutable=JSON.parse(execFileSync('gh',['api','repos/crazylin/codeferry/releases/406985511'],{encoding:'utf8',timeout:60000,maxBuffer:1048576,stdio:['ignore','pipe','ignore']}));
  assert.equal(immutable.id,406985511);
  assert.equal(immutable.draft,false);
  assert.equal(immutable.tag_name,'build-37800222913-1');
  assert.equal(immutable.target_commitish,PLAN.source);
  assert.equal(immutable.assets?.length,2);
  assert.equal(immutable.assets.find(x=>x.name===PLAN.filename)?.size,PLAN.size);
  const journalFile=join(process.env.RUNNER_TEMP,'gateway-037-deployment-journal.json');
  const journal={schema:1,existingPublishedRelease:PLAN.release,events:[]};
  async function note(e,additional={}) {
    journal.events.push({event:e,at:new Date().toISOString(),...additional});
    await writeFile(journalFile,JSON.stringify(journal,null,2),{mode:0o600});
    console.log('GATEWAY037_'+e);
  }
  async function request(path,method='GET',data,headers={},timeoutMs=90000) {
    await note('REQUEST_'+method);
    let resp, json;
    try { resp=await fetch('https://codeferry.link'+path,{
      method,redirect:'error',signal:AbortSignal.timeout(timeoutMs),
      headers:{authorization:'Bearer '+key,'content-type':'application/json',...headers},
      ...(method==='GET'?{}:{body:JSON.stringify(data??{})})
    });
      json=await readBoundedJson(resp);
    }
    catch {
      await note(method==='GET'?'READ_UNAVAILABLE_GET':'OUTCOME_UNKNOWN_'+method);
      throw Error(method==='GET'?'POLL_READ_UNAVAILABLE':'NO_NON_IDEMPOTENT_REPLAY');
    }
    await note('RESPONSE_'+method,{httpStatus:resp.status});
    if(!resp.ok)throw Error('REMOTE_HTTP_'+resp.status+'_'+safeApiErrorCode(json.error));
    return json;
  }
  const publicHealth=await fetch('https://codeferry.link/healthz',{signal:AbortSignal.timeout(10000)}).then(readBoundedJson);
  if(verifyBeforeDeployHealth(publicHealth)) {await note('ALREADY_DEPLOYED');return;}
  await note('METADATA_VERIFIED_AND_BEFORE_DEPLOY_CHECKED',{version:publicHealth.version});
  const result=await request('/api/releases/'+PLAN.release+'/deploy','POST',{},
    {'idempotency-key':PLAN.idempotencyKey});
  const id=result.deployment?.id;
  if(typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    await note('OUTCOME_UNKNOWN_POST');
    throw Error('DEPLOYMENT_RESPONSE_INVALID_NO_REPLAY');
  }
  await note('DEPLOYMENT_SUBMITTED',{deploymentId:id});
  await pollDeployment({id,note,
    readDeployment:async timeoutMs=>(await request('/api/deployments/'+id,'GET',undefined,{},timeoutMs)).deployment,
  });
  await note('WORKER_SUCCEEDED');
  const health=await fetch('https://codeferry.link/healthz',{signal:AbortSignal.timeout(20000)}).then(readBoundedJson);
  const native=await fetch('https://codeferry.link/native/healthz',{signal:AbortSignal.timeout(20000)}).then(readBoundedJson);
  assert.equal(health.status,'ok');
  assert.equal(health.version,PLAN.version);
  assert.equal(native.status,'ok');
  await note('HEALTH_VERIFIED',{gatewayVersion:health.version,nativeVersion:native.version});
  console.log('GATEWAY037_VERIFIED_DEPLOYMENT_SUCCEEDED');
}
if(process.argv[1]===fileURLToPath(import.meta.url))main().catch(e=>{
  console.error('GATEWAY037_DEPLOYMENT_BLOCKED_'+String(e.message).replace(/[^A-Z0-9_]/gi,'_').slice(0,90));
  process.exitCode=1;
});
