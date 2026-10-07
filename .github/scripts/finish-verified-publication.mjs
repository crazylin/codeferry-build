import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,readdir,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {identity,verifyTauriSignature} from './assets.mjs';
import {signDebian} from './sign-debian.mjs';
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
export const EXISTING=Object.freeze({'tar.gz':'3fdb3e9a-f5bb-45d2-b09d-54cc8e5e65f2','dmg':'52f68f73-f0c7-492e-b3dd-ec8680e9e67a','AppImage':'b167018a-eb0d-474a-928f-45b9d307e348'});
export function validatePublished(publicRows,rows){
 assert.equal(publicRows.length,3);
 for(const p of publicRows){assert.equal(p.id,EXISTING[p.format]);assert.equal(p.status,'published');const r=rows.find(r=>r.component==='desktop'&&r.format===p.format);assert.ok(r);for(const k of ['component','version','platform','arch','variant','sourceCommit','format','size','sha256','clientEngine'])assert.equal(p[k],r[k]);assert.equal(p.updaterSignature??undefined,r.updaterSignature);if(p.format==='AppImage')assert.equal(p.updateTarget,'linux-x86_64');else assert.equal(p.updateTarget??undefined,r.updateTarget);}
 assert.equal(new Set(publicRows.map(r=>r.id)).size,3);
}
async function main(){
 const journal={schemaVersion:1,originalRun:PLAN.run,sourceCommit:PLAN.source,events:[]};const journalPath=join(process.env.RUNNER_TEMP,'publication-finish.json');
 async function record(value){journal.events.push({...value,at:new Date().toISOString()});await writeFile(journalPath,JSON.stringify(journal,null,2),{mode:0o600});}
 await record({phase:'preflight_started_no_server_mutation'});
 const key=process.env.CODEFERRY_PUBLISH_KEY;assert.ok(/^cfr_publish_\S{1,500}$/.test(key??''));
 const gh=path=>JSON.parse(execFileSync('gh',['api',path],{encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:60000,maxBuffer:2*1024**2}));
 const repo='repos/crazylin/codeferry-build/actions/runs/'+PLAN.run;const run=gh(repo);validateEvidence(run,gh(repo+'/jobs?per_page=100').jobs);
 assert.equal(gh('repos/crazylin/codeferry').private,true);
 const source=resolve('source'),dir=resolve(process.env.ASSET_DIR);assert.equal(execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),PLAN.source);
 const rows=[],files=await readdir(dir);const pub=await readFile(join(source,'desktop-tauri/updater.pub'),'utf8');
 for(const name of files.filter(n=>n.endsWith('.metadata.json'))){
  const raw=await readFile(join(dir,name),'utf8');assert.ok(Buffer.byteLength(raw)<=32768);const row=JSON.parse(raw);assert.match(row.filename,/^[A-Za-z0-9_.-]{1,180}$/);assert.equal(name,row.filename+'.metadata.json');const file=join(dir,row.filename);assert.ok((await lstat(file)).isFile()&&!(await lstat(file)).isSymbolicLink());const actual=await identity(file);assert.equal(actual.size,row.size);assert.equal(actual.sha256,row.sha256);if(row.updaterSignature)await verifyTauriSignature(file,row.updaterSignature,pub,row.version);rows.push(row);
 }
 assert.equal(files.length,12);assert.equal(rows.length,6);
 const pinned={"CodeFerry-0.2.14-win32-x64.exe": {"size": 10661268, "sha256": "5c58a11fb485e745d81daa3bc0ce86eb04d9a1c8f264aa6556f2c31ff66dc635"}, "CodeFerry-0.2.14-linux-x64.deb": {"size": 18972372, "sha256": "c16538fb94ee458f25b2e0ecafa95a53c097c75ae66aa92247f98d004c139c29"}, "CodeFerry-0.2.14-linux-x64.AppImage": {"size": 95656440, "sha256": "0b2baff890a782c19dafd50b7cbf8a71bcebc4d521ffc30e3453cf1f9156f46e"}, "CodeFerry-0.2.14-darwin-arm64.dmg": {"size": 25720782, "sha256": "efabdb8ad55a67db836e3d75a5412fb821615b65d72014bb736677c8d0a2638f"}, "CodeFerry-gateway-0.3.2-linux-x64.tar.gz": {"size": 55991951, "sha256": "e0ff94536c7fa3de98af11261cff3f3b99c54131c99ba6d9104d5ab9506d2260"}, "CodeFerry-0.2.14-darwin-arm64.app.tar.gz": {"size": 16276611, "sha256": "c5af19ad789836cb39fd725963f6160c1a744c800e79cf6017cb74efe9036ace"}};
 for(const row of rows){const proof=pinned[row.filename];assert.ok(proof);assert.equal(row.size,proof.size);assert.equal(row.sha256,proof.sha256);assert.equal(row.sourceCommit,PLAN.source);}
 assert.equal(new Set(rows.map(r=>r.filename)).size,6);
 const prior=gh('repos/crazylin/codeferry-build/actions/runs/37639850043');assert.equal(prior.head_sha,'8f1ac9296e5afe8145d57d6281519a5356b86cdf');assert.equal(prior.status,'completed');assert.equal(prior.conclusion,'failure');
 const previous=JSON.parse(await readFile(join(process.env.RUNNER_TEMP,'previous-recovery/publication-recovery.json'),'utf8'));
 assert.equal(createHash('sha256').update(JSON.stringify(previous)).digest('hex'),'df89ff8de45bff7f5bb18f7502d79f7574c0b64c351ebc2b8327609d509c1b3a');
 await record({phase:'original_six_hashes_and_prior_journal_verified_signing_debian'});
 const deb=rows.find(r=>r.format==='deb');assert.ok(!deb.updaterSignature&&!deb.updateTarget);
 deb.updaterSignature=await signDebian(join(dir,deb.filename),source,deb.version);deb.updateTarget='linux-x86_64-deb';
 const image=rows.find(r=>r.format==='AppImage');assert.equal(image.updateTarget,'linux-x86_64');image.updateTarget='linux-x86_64-appimage';
 validateReleaseSet(rows,{sourceSha:PLAN.source,desktopVersion:'0.2.14',gatewayVersion:'0.3.2',scope:'all'});
 await writeFile(join(process.env.RUNNER_TEMP,'debian-signing-evidence.json'),JSON.stringify({originalRun:PLAN.run,originalMetadataUnchanged:true,artifactBytesUnchanged:true,metadata:deb},null,2),{mode:0o600});
 async function boundedJson(response){const reader=response.body?.getReader();const parts=[];let size=0;if(reader){try{for(;;){const p=await reader.read();if(p.done)break;size+=p.value.byteLength;if(size>262144){await reader.cancel();throw Error('RECOVERY_RESPONSE_LIMIT');}parts.push(Buffer.from(p.value));}}finally{reader.releaseLock();}}return JSON.parse(Buffer.concat(parts).toString());}
 async function transport(url,options){
  const parsed=new URL(url);assert.equal(parsed.origin,'https://codeferry.link');const method=options.method;
  await record({phase:'request',method,path:parsed.pathname});
  let response;try{response=await fetch(url,options);}catch{await record({phase:'transport_unknown',method,path:parsed.pathname});throw Error('RECOVERY_TRANSPORT_UNKNOWN');}
  const body=await boundedJson(response.clone());await record({phase:'response',method,path:parsed.pathname,httpStatus:response.status,releaseId:body.release?.id,uploadId:body.upload?.id,deploymentId:body.deployment?.id,status:body.release?.status??body.upload?.status??body.deployment?.status,error:/^[A-Z_0-9]{1,100}$/.test(body.error??'')?body.error:undefined});return response;
 }
 async function api(path,method,body){const r=await transport('https://codeferry.link'+path,{method,redirect:'error',signal:AbortSignal.timeout(120000),headers:{authorization:'Bearer '+key,'content-type':Buffer.isBuffer(body)?'application/octet-stream':'application/json',...(Buffer.isBuffer(body)?{'x-chunk-sha256':createHash('sha256').update(body).digest('hex')}:{})},...(method==='GET'?{}:{body:Buffer.isBuffer(body)?body:JSON.stringify(body)})});assert.ok(r.ok);return boundedJson(r);}
 await record({phase:'all_original_build_gates_and_artifact_hashes_verified'});
 const publicRows=(await api('/api/releases','GET')).releases.filter(r=>r.version==='0.2.14');
 validatePublished(publicRows,rows);await record({phase:'three_existing_publications_reconciled_not_replayed'});
 const {publishArtifact}=await import(pathToFileURL(join(source,'scripts/publish-release.mjs')));
 for(const row of rows.filter(r=>r.component==='gateway'||!EXISTING[r.format]).sort((a,b)=>(a.component==='gateway'?1:0)-(b.component==='gateway'?1:0)||a.filename.localeCompare(b.filename))){
  const result=await publishArtifact({file:join(dir,row.filename),metadata:row,key,deploy:row.component==='gateway',waitDeployment:true,transport});await record({phase:'artifact_published',...result});
 }
 await record({phase:'completed'});console.log('VERIFIED_RELEASE_SET_AND_GATEWAY_DEPLOYMENT_COMPLETE');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('PUBLICATION_RECOVERY_BLOCKED_CHECK_PRIVATE_JOURNAL_NO_REPLAY');process.exitCode=1;});
