/** Deploy only the already-published, immutable 0.3.6 gateway. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PLAN = Object.freeze({
  release: '02d55c74-937e-499a-bca8-a2e2a0527ec1',
  source: 'fcc9c5e4fdfd3f87b41ea19c6783562e9bf5f9f1',
  version: '0.3.6',
  filename: 'CodeFerry-gateway-0.3.6-linux-x64.tar.gz',
  size: 56221359,
  sha256: 'c86a2e48bc24f1571870412d7195796c969c70d3972dbf330c1d1b8e5affe811',
  idempotencyKey: 'gateway036-existing-build37790167207',
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
async function main() {
  const key=process.env.CODEFERRY_PUBLISH_KEY;
  assert.match(key??'',/^cfr_publish_[A-Za-z0-9_-]{8,500}$/);
  const meta=JSON.parse(await readFile(join(process.env.ASSET_DIR,PLAN.filename+'.metadata.json'),'utf8'));
  verifyMetadata(meta);
  const run=JSON.parse(execFileSync('gh',['api','repos/crazylin/codeferry-build/actions/runs/37790167207'],{encoding:'utf8',timeout:60000,maxBuffer:1048576,stdio:['ignore','pipe','ignore']}));
  assert.equal(run.conclusion,'success');
  const journalFile=join(process.env.RUNNER_TEMP,'gateway-036-deployment-journal.json');
  const journal={schema:1,existingPublishedRelease:PLAN.release,events:[]};
  async function note(e,additional={}) {
    journal.events.push({event:e,at:new Date().toISOString(),...additional});
    await writeFile(journalFile,JSON.stringify(journal,null,2),{mode:0o600});
    console.log('GATEWAY036_'+e);
  }
  async function request(path,method='GET',data,headers={}) {
    await note('REQUEST_'+method);
    let resp;
    try { resp=await fetch('https://codeferry.link'+path,{
      method,redirect:'error',signal:AbortSignal.timeout(90000),
      headers:{authorization:'Bearer '+key,'content-type':'application/json',...headers},
      ...(method==='GET'?{}:{body:JSON.stringify(data??{})})
    }); }
    catch {await note('OUTCOME_UNKNOWN_'+method);throw Error('NO_NON_IDEMPOTENT_REPLAY');}
    const text=await resp.text();
    assert.ok(text.length<262144);
    const json=JSON.parse(text);
    await note('RESPONSE_'+method,{httpStatus:resp.status});
    if(!resp.ok)throw Error('REMOTE_HTTP_'+resp.status+'_'+(/^RELEASE_[A-Z_0-9]+$/.test(json.error??'')?json.error:'REJECTED'));
    return json;
  }
  const publicHealth=await fetch('https://codeferry.link/healthz',{signal:AbortSignal.timeout(10000)}).then(r=>r.json());
  assert.equal(publicHealth.status,'ok');
  if(publicHealth.version==='0.3.6') {await note('ALREADY_DEPLOYED');return;}
  assert.equal(publicHealth.version,'0.3.4','PRODUCTION_VERSION_CHANGED_NO_DEPLOY');
  await note('METADATA_VERIFIED_AND_BEFORE_DEPLOY_CHECKED',{version:publicHealth.version});
  const result=await request('/api/releases/'+PLAN.release+'/deploy','POST',{},
    {'idempotency-key':PLAN.idempotencyKey});
  const id=result.deployment?.id;
  assert.match(id??'',/^[0-9a-f-]{36}$/);
  await note('DEPLOYMENT_SUBMITTED',{deploymentId:id});
  const deadline=Date.now()+45*60*1000;
  for(;;) {
    assert.ok(Date.now()<deadline,'POLL_TIMEOUT_NO_REPLAY');
    await new Promise(resolve=>setTimeout(resolve,3000));
    let dep;
    try { dep=(await request('/api/deployments/'+id)).deployment; }
    catch {continue;}
    assert.equal(dep.id,id);
    if(dep.status==='succeeded')break;
    if(dep.status==='failed'||dep.status==='outcome_unknown') {
      await note('DEPLOYMENT_'+dep.status.toUpperCase());
      throw Error('WORKER_'+dep.status.toUpperCase()+'_NO_REPLAY');
    }
    assert.ok(['pending','running'].includes(dep.status));
  }
  await note('WORKER_SUCCEEDED');
  const health=await fetch('https://codeferry.link/healthz',{signal:AbortSignal.timeout(20000)}).then(r=>r.json());
  const native=await fetch('https://codeferry.link/native/healthz',{signal:AbortSignal.timeout(20000)}).then(r=>r.json());
  assert.equal(health.status,'ok');
  assert.equal(health.version,PLAN.version);
  assert.equal(native.status,'ok');
  await note('HEALTH_VERIFIED',{gatewayVersion:health.version,nativeVersion:native.version});
  console.log('GATEWAY036_VERIFIED_DEPLOYMENT_SUCCEEDED');
}
if(process.argv[1]===fileURLToPath(import.meta.url))main().catch(e=>{
  console.error('GATEWAY036_DEPLOYMENT_BLOCKED_'+String(e.message).replace(/[^A-Z0-9_]/gi,'_').slice(0,90));
  process.exitCode=1;
});
