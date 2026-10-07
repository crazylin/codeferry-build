import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PLAN,validateEvidence,validateResumeUpload} from '../resume-verified-publication.mjs';
const names=['Resolve one immutable private source commit','Contracts and real PostgreSQL Redis validation','Create one private immutable build draft','Signed Tauri desktop linux x64','Signed Tauri desktop darwin arm64','Signed Tauri desktop win32 x64','Embedded gateway Docker image linux amd64'];
const run={id:PLAN.run,head_sha:PLAN.workflow,status:'completed',conclusion:'failure',event:'workflow_dispatch'};
const jobs=[...names.map(name=>({name,conclusion:'success'})),{name:'Publish verified release set and update gateway',conclusion:'failure'}];
test('recovery requires every original immutable build gate and only failed publication',()=>{
 assert.doesNotThrow(()=>validateEvidence(run,jobs));
 for(let i=0;i<jobs.length;i++)assert.throws(()=>validateEvidence(run,jobs.filter((_,n)=>n!==i)));
 for(let i=0;i<7;i++)assert.throws(()=>validateEvidence(run,jobs.map((j,n)=>n===i?{...j,conclusion:'skipped'}:j)));
 for(const change of [{id:1},{head_sha:'a'.repeat(40)},{status:'in_progress'},{conclusion:'success'},{event:'push'}])assert.throws(()=>validateEvidence({...run,...change},jobs));
});
test('only reconciled active empty upload may be resumed, never an unknown or completed mutation',()=>{
 const u={id:PLAN.upload,releaseId:PLAN.release,status:'active',size:PLAN.size,chunkSize:16*1024**2,chunkCount:1,received:[],expiresAt:Date.now()+3600000};
 assert.doesNotThrow(()=>validateResumeUpload(u));
 for(const change of [{id:'other'},{releaseId:'other'},{status:'completed'},{size:1},{chunkSize:1},{chunkCount:2},{received:[0]},{expiresAt:0}])assert.throws(()=>validateResumeUpload({...u,...change}));
});
test('recovery retains signature, hash, deployment wait and private journal gates',async()=>{
 const script=await readFile(new URL('../resume-verified-publication.mjs',import.meta.url),'utf8');
 for(const text of ['verifyTauriSignature','validateReleaseSet','validateEvidence','validateResumeUpload','waitDeployment:true','publication-recovery.json'])assert.ok(script.includes(text));
 assert.doesNotMatch(script,/method:\s*['"]DELETE/);
 const workflow=await readFile(new URL('../../workflows/resume-publication.yml',import.meta.url),'utf8');
 assert.doesNotMatch(workflow,/upload-artifact|CODEFERRY_SSH_PASSWORD|--clobber|--force/);assert.match(workflow,/if: always\(\)/);assert.match(workflow,/--repo crazylin\/codeferry --draft/);
});

test('workflow runner paths are configured only in steps',async()=>{
 for(const name of ['resume-publication','finish-publication']){const s=await readFile(new URL('../../workflows/'+name+'.yml',import.meta.url),'utf8');assert.doesNotMatch(s,/ASSET_DIR:.*runner\.temp/);assert.match(s,/ASSET_DIR=\$RUNNER_TEMP/);}
});
test('finish requires exact already-published identities and never accepts partial or changed rows',async()=>{
 const {validatePublished,EXISTING}=await import('../finish-verified-publication.mjs');
 const rows=Object.keys(EXISTING).map(format=>({component:'desktop',format,sourceCommit:PLAN.source,version:'0.2.14',sha256:'a'.repeat(64),size:123,updaterSignature:format==='dmg'?undefined:'signed',updateTarget:format==='AppImage'?'linux-x86_64-appimage':format==='tar.gz'?'darwin-aarch64':undefined}));
 const published=rows.map(r=>({...r,id:EXISTING[r.format],status:'published',updateTarget:r.format==='AppImage'?'linux-x86_64':r.updateTarget}));
 assert.doesNotThrow(()=>validatePublished(published,rows));
 for(const change of [{id:'other'},{sha256:'b'.repeat(64)},{size:1},{status:'draft'},{sourceCommit:'b'.repeat(40)},{updaterSignature:'other'}])assert.throws(()=>validatePublished(published.map((r,i)=>i===0?{...r,...change}:r),rows));
 assert.throws(()=>validatePublished(published.slice(1),rows));assert.throws(()=>validatePublished([...published,published[0]],rows));
});
test('finish preserves original six byte identities and signs before the full four-signature gate',async()=>{
 const s=await readFile(new URL('../finish-verified-publication.mjs',import.meta.url),'utf8');assert.ok(s.indexOf('await signDebian(')<s.indexOf(' validateReleaseSet(rows,'));for(const text of ['37639850043','validateEvidence','validatePublished','waitDeployment:true','debian-signing-evidence.json'])assert.ok(s.includes(text));assert.doesNotMatch(s,/--clobber|method:\s*['"]DELETE/);
});
