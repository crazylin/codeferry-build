import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,readdir,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {identity,verifyTauriSignature} from './assets.mjs';
import {validateReleaseSet} from './publish-server.mjs';
export const PLAN=Object.freeze({run:37628859938,source:'5cbb746b024cbc12e81333fcc74c82cd596bc02d',workflow:'0f4c1d8b72382861767798ea63e3fefd6c0246f3',release:'3fdb3e9a-f5bb-45d2-b09d-54cc8e5e65f2',upload:'237a66ec-eb43-4edf-9ec1-e4b419963583',filename:'CodeFerry-0.2.14-darwin-arm64.app.tar.gz',size:16276611,sha256:'c5af19ad789836cb39fd725963f6160c1a744c800e79cf6017cb74efe9036ace'});
export function validateEvidence(run,jobs){
 assert.equal(run.id,PLAN.run);assert.equal(run.head_sha,PLAN.workflow);assert.equal(run.status,'completed');assert.equal(run.conclusion,'failure');assert.equal(run.event,'workflow_dispatch');
 const expected=['Resolve one immutable private source commit','Contracts and real PostgreSQL Redis validation','Create one private immutable build draft','Signed Tauri desktop linux x64','Signed Tauri desktop darwin arm64','Signed Tauri desktop win32 x64','Embedded gateway Docker image linux amd64'];
 for(const name of expected){const rows=jobs.filter(j=>j.name===name);assert.equal(rows.length,1);assert.equal(rows[0].conclusion,'success');}
 const publisher=jobs.filter(j=>j.name==='Publish verified release set and update gateway');assert.equal(publisher.length,1);assert.equal(publisher[0].conclusion,'failure');assert.equal(jobs.length,8);
}
export function validateResumeUpload(u){
 assert.equal(u.id,PLAN.upload);assert.equal(u.releaseId,PLAN.release);assert.equal(u.status,'active');assert.equal(u.size,PLAN.size);assert.equal(u.chunkSize,16*1024**2);assert.equal(u.chunkCount,1);assert.deepEqual(u.received,[]);assert.ok(u.expiresAt>Date.now());
}
async function main(){
 const key=process.env.CODEFERRY_PUBLISH_KEY;assert.ok(/^cfr_publish_\S{1,500}$/.test(key??''));
 const gh=path=>JSON.parse(execFileSync('gh',['api',path],{encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:60000,maxBuffer:2*1024**2}));
 const repo='repos/crazylin/codeferry-build/actions/runs/'+PLAN.run;const run=gh(repo);validateEvidence(run,gh(repo+'/jobs?per_page=100').jobs);
 assert.equal(gh('repos/crazylin/codeferry').private,true);
 const source=resolve('source'),dir=resolve(process.env.ASSET_DIR);assert.equal(execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),PLAN.source);
 const rows=[],files=await readdir(dir);const pub=await readFile(join(source,'desktop-tauri/updater.pub'),'utf8');
 for(const name of files.filter(n=>n.endsWith('.metadata.json'))){
  const raw=await readFile(join(dir,name),'utf8');assert.ok(Buffer.byteLength(raw)<=32768);const row=JSON.parse(raw);assert.match(row.filename,/^[A-Za-z0-9_.-]{1,180}$/);assert.equal(name,row.filename+'.metadata.json');const file=join(dir,row.filename);assert.ok((await lstat(file)).isFile()&&!(await lstat(file)).isSymbolicLink());const actual=await identity(file);assert.equal(actual.size,row.size);assert.equal(actual.sha256,row.sha256);if(row.updaterSignature)await verifyTauriSignature(file,row.updaterSignature,pub,row.version);rows.push(row);
 }
 validateReleaseSet(rows,{sourceSha:PLAN.source,desktopVersion:'0.2.14',gatewayVersion:'0.3.2',scope:'all'});assert.equal(files.length,12);
 const first=rows.find(r=>r.filename===PLAN.filename);assert.ok(first);assert.equal(first.size,PLAN.size);assert.equal(first.sha256,PLAN.sha256);
 const journal={schemaVersion:1,originalRun:PLAN.run,sourceCommit:PLAN.source,events:[]};const journalPath=join(process.env.RUNNER_TEMP,'publication-recovery.json');
 async function record(value){journal.events.push({...value,at:new Date().toISOString()});await writeFile(journalPath,JSON.stringify(journal,null,2),{mode:0o600});}
 async function boundedJson(response){const reader=response.body?.getReader();const parts=[];let size=0;if(reader){try{for(;;){const p=await reader.read();if(p.done)break;size+=p.value.byteLength;if(size>262144){await reader.cancel();throw Error('RECOVERY_RESPONSE_LIMIT');}parts.push(Buffer.from(p.value));}}finally{reader.releaseLock();}}return JSON.parse(Buffer.concat(parts).toString());}
 async function transport(url,options){
  const parsed=new URL(url);assert.equal(parsed.origin,'https://codeferry.link');const method=options.method;
  await record({phase:'request',method,path:parsed.pathname});
  let response;try{response=await fetch(url,options);}catch{await record({phase:'transport_unknown',method,path:parsed.pathname});throw Error('RECOVERY_TRANSPORT_UNKNOWN');}
  const body=await boundedJson(response.clone());await record({phase:'response',method,path:parsed.pathname,httpStatus:response.status,releaseId:body.release?.id,uploadId:body.upload?.id,deploymentId:body.deployment?.id,status:body.release?.status??body.upload?.status??body.deployment?.status,error:/^[A-Z_0-9]{1,100}$/.test(body.error??'')?body.error:undefined});return response;
 }
 async function api(path,method,body){const r=await transport('https://codeferry.link'+path,{method,redirect:'error',signal:AbortSignal.timeout(120000),headers:{authorization:'Bearer '+key,'content-type':Buffer.isBuffer(body)?'application/octet-stream':'application/json',...(Buffer.isBuffer(body)?{'x-chunk-sha256':createHash('sha256').update(body).digest('hex')}:{})},...(method==='GET'?{}:{body:Buffer.isBuffer(body)?body:JSON.stringify(body)})});assert.ok(r.ok);return boundedJson(r);}
 await record({phase:'all_original_build_gates_and_artifact_hashes_verified'});
 const current=(await api('/api/uploads/'+PLAN.upload,'GET')).upload;validateResumeUpload(current);
 // Exact known draft/session only. No creation, cancellation, deletion or overwrite.
 await api('/api/uploads/'+PLAN.upload+'/chunks/0','PUT',await readFile(join(dir,first.filename)));
 const completed=(await api('/api/uploads/'+PLAN.upload+'/complete','POST',{})).release;assert.equal(completed.id,PLAN.release);assert.equal(completed.sha256,PLAN.sha256);assert.equal(completed.size,PLAN.size);
 const published=(await api('/api/releases/'+PLAN.release+'/publish','POST',{})).release;assert.equal(published.id,PLAN.release);assert.equal(published.status,'published');assert.equal(published.sha256,PLAN.sha256);
 await record({phase:'existing_draft_published',releaseId:PLAN.release});
 const {publishArtifact}=await import(pathToFileURL(join(source,'scripts/publish-release.mjs')));
 for(const row of rows.filter(r=>r!==first).sort((a,b)=>(a.component==='gateway'?1:0)-(b.component==='gateway'?1:0)||a.filename.localeCompare(b.filename))){
  const result=await publishArtifact({file:join(dir,row.filename),metadata:row,key,deploy:row.component==='gateway',waitDeployment:true,transport});await record({phase:'artifact_published',...result});
 }
 await record({phase:'completed'});console.log('VERIFIED_RELEASE_SET_AND_GATEWAY_DEPLOYMENT_COMPLETE');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('PUBLICATION_RECOVERY_BLOCKED_CHECK_PRIVATE_JOURNAL_NO_REPLAY');process.exitCode=1;});
