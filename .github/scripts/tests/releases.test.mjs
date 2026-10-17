import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectedMetadata, artifactName, writeMetadata, verifyTauriSignature } from '../assets.mjs';
import { requireProductionEngine, validateReleaseSet, verificationOnly, runPublication, requireReadyGateway, publicationOrigin, publicationFailure } from '../publish-server.mjs';
import { resolveGatewayBinary } from '../gateway-image.mjs';
const sha='a'.repeat(40), hash='b'.repeat(64);
const options={sourceSha:sha,desktopVersion:'0.2.0',gatewayVersion:'0.3.0'};
const signedFixture={"key": "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDhEMzQ3NzNBMzQ3OTZCQTkKUldTcGEzazBPbmMwalluUWxZWmRsNkpVdDBGNHRWWUM4TjVZL09ROHFIeGo0bkEvcm1Wb2EvWjAK", "signature": "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTcGEzazBPbmMwamJlYys3YTlka3JNNDJ5NHdIRTAyMlBGeGVwTDljSzhtWjdWdi9zWHZDeWsrV1VaOFp1eXRuaUo3U2wzU3AvNm4wRkNGUm44eUxWaDJGZzBWR2ZPTnc4PQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkxMjIyOTM2CWZpbGU6dGVzdC5iaW4JdmVyc2lvbjowLjIuMApJYURmVGhGMWREdFBxMFVQR2xaQ1NJbEsxL1BaR0R5TWtFWFoxNzc3MnBUeFlLakFWVXFmeDJBbTVrYnE2Q2swSXo3Ykx5amh0OUZvRllyTE1GdXJEQT09Cg==", "bytes": "CodeFerry signed update fixture bytes"};
function records() {
 const rows=[];
 for(const [platform,arch,formats] of [['darwin','arm64',['dmg','tar.gz']],['win32','x64',['exe']],['linux','x64',['AppImage','deb']]]) for(const format of formats) rows.push(expectedMetadata('desktop','0.2.0',platform,arch,'full',artifactName('0.2.0',platform,arch,format),sha,format,signedFixture.signature));
 rows.push(expectedMetadata('gateway','0.3.0','linux','x64','full','CodeFerry-gateway-0.3.0-linux-x64.tar.gz',sha));
 return rows.map(row=>({...row,sha256:hash,size:123}));
}
async function fixture(body) {const root=await mkdtemp(join(tmpdir(),'codeferry-workflow-'));try{return await body(root);}finally{await rm(root,{recursive:true,force:true});}}
async function publicationFixture(body) {
 return fixture(async root=>{
  const sourceRoot=join(root,'source'),assetDirectory=join(root,'assets');
  await mkdir(join(sourceRoot,'desktop-tauri'),{recursive:true});await mkdir(join(sourceRoot,'gateway-rs'));await mkdir(assetDirectory);
  await writeFile(join(sourceRoot,'desktop-tauri/package.json'),JSON.stringify({version:options.desktopVersion}));
  await writeFile(join(sourceRoot,'desktop-tauri/updater.pub'),signedFixture.key);
  await writeFile(join(sourceRoot,'gateway-rs/Cargo.toml'),`[package]\nversion = "${options.gatewayVersion}"\n`);
  for(const row of records()) {
   const file=join(assetDirectory,row.filename);await writeFile(file,signedFixture.bytes);
   const {sha256:ignoredHash,size:ignoredSize,...metadata}=row;await writeMetadata(file,metadata);
  }
  const output=[],calls=[],healthCalls=[],events=[];let loads=0;
  const environment={SOURCE_SHA:sha,RELEASE_SCOPE:'all',VERIFY_ONLY:'true',DEPLOY_GATEWAY:'false'};
  const run=overrides=>runPublication({sourceRoot,assetDirectory,environment,log:value=>output.push(value),
   loadPublisher:async()=>{loads++;return {publishArtifact:async call=>{calls.push(call);events.push('publish_'+call.metadata.component);}};},
   healthTransport:async(...args)=>{healthCalls.push(args);events.push('health');return Response.json({product:'CodeFerry',status:'ok',engine:'gateway-rs',version:options.gatewayVersion});},...overrides});
  await body({sourceRoot,assetDirectory,environment,output,calls,healthCalls,events,run,get loads(){return loads;}});
 });
}
test('complete signed Tauri set requires five installers and one embedded gateway',()=>{
 const rows=records();assert.equal(rows.length,6);validateReleaseSet(rows,options);
 assert.throws(()=>validateReleaseSet(rows.slice(1),options),/INCOMPLETE/);
 const duplicate=[...rows];duplicate[0]=duplicate[1];assert.throws(()=>validateReleaseSet(duplicate,options),/INVALID/);
 validateReleaseSet(rows.filter(row=>row.component==='gateway'),{...options,scope:'gateway'});
 validateReleaseSet(rows.filter(row=>row.component==='desktop'),{...options,scope:'desktop'});
 assert.throws(()=>validateReleaseSet(rows.filter(row=>row.component==='desktop').slice(1),{...options,scope:'desktop'}),/INCOMPLETE/);
 assert.throws(()=>validateReleaseSet(rows,{...options,scope:'desktop'}),/INCOMPLETE/);
 assert.throws(()=>validateReleaseSet(rows,{...options,scope:'gateway'}),/INCOMPLETE/);
});
test('source version filename channel engine target signature size digest are exact',()=>{
 for(const edit of [{sourceCommit:'c'.repeat(40)},{version:'0.1.19'},{filename:'../app.dmg'},{channel:'preview'},{sha256:hash.toUpperCase()},{size:0},{size:2**32},{clientEngine:'electron'},{variant:'slim'},{format:'zip'}]) {
  const rows=records();rows[0]={...rows[0],...edit};assert.throws(()=>validateReleaseSet(rows,options),/INVALID/);
 }
 for(const edit of [{updaterSignature:undefined},{updateTarget:'windows-x86_64'}]) {const rows=records();rows[1]={...rows[1],...edit};assert.throws(()=>validateReleaseSet(rows,options),/INVALID/);}
 assert.throws(()=>validateReleaseSet(records(),{...options,desktopVersion:'0.02.0'}),/CONFIGURATION_INVALID/);
});
test('Electron and runtime publishing paths are retired',()=>{
 requireProductionEngine('tauri');for(const engine of ['electron','','other']) assert.throws(()=>requireProductionEngine(engine),/CLIENT_ENGINE_INVALID/);
 assert.throws(()=>expectedMetadata('runtime','44.5.1','linux','x64','full','electron.zip',sha),/INVALID/);
});
test('actual immutable hashes are derived from bytes and metadata cannot overwrite',async()=>fixture(async root=>{
 const file=join(root,'test.dmg'),bytes=Buffer.from('actual fixture bytes');await writeFile(file,bytes);
 const metadata=expectedMetadata('desktop','0.2.0','darwin','arm64','full','test.dmg',sha,'dmg');await writeMetadata(file,metadata);
 const row=JSON.parse(await readFile(file+'.metadata.json','utf8'));assert.equal(row.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(row.size,bytes.length);
 await assert.rejects(writeMetadata(file,metadata),{code:'EEXIST'});
}));
test('official Tauri signature checks bytes and trusted signed version before upload',async()=>fixture(async root=>{
 const file=join(root,'update.app.tar.gz');await writeFile(file,signedFixture.bytes);
 await verifyTauriSignature(file,signedFixture.signature,signedFixture.key,'0.2.0');
 await assert.rejects(verifyTauriSignature(file,signedFixture.signature,signedFixture.key,'9.0.0'),/SIGNATURE_INVALID/);
 await assert.rejects(verifyTauriSignature(file,signedFixture.signature.slice(1),signedFixture.key,'0.2.0'),/SIGNATURE_INVALID/);
 await writeFile(file,'tampered');await assert.rejects(verifyTauriSignature(file,signedFixture.signature,signedFixture.key,'0.2.0'),/SIGNATURE_INVALID/);
}));
test('macOS bundle is sealed and its updater archive is re-signed before release collection',async()=>{
 const workflow=await readFile(new URL('../../workflows/desktop-clients.yml',import.meta.url),'utf8');
 const finalize=workflow.indexOf('node source/scripts/finalize-macos-package.mjs');
 const collect=workflow.indexOf('node .github/scripts/assets.mjs tauri source');
 assert.notEqual(finalize,-1);assert.notEqual(collect,-1);assert.ok(finalize<collect);
 assert.match(workflow.slice(workflow.lastIndexOf('      - name: Seal macOS app',finalize),collect),/if: runner\.os == 'macOS'/u);
 assert.match(workflow.slice(workflow.lastIndexOf('      - name: Seal macOS app',finalize),collect),/TAURI_SIGNING_PRIVATE_KEY/u);
});
const elf = () => { const bytes = Buffer.alloc(64); Buffer.from([0x7f,0x45,0x4c,0x46]).copy(bytes); bytes[4]=2; bytes[5]=1; bytes.writeUInt16LE(62,18); return bytes; };
test('stage-only binary accepts canonical target or source alias, rejects outside and bad ELF', async () => fixture(async root => {
  const source = join(root, 'source'); const target = join(source, 'gateway-rs', 'target', 'linux', 'release'); await mkdir(target, { recursive: true });
  const path = join(target, 'codeferry-gateway'); await writeFile(path, elf());
  assert.equal((await resolveGatewayBinary(source, path)).size, 64);
  const alias = join(root, 'alias'); await symlink(source, alias, 'dir');
  assert.equal((await resolveGatewayBinary(alias, join(alias, 'gateway-rs/target/linux/release/codeferry-gateway'))).path, await realpath(path));
  const outside = join(root, 'elsewhere'); await writeFile(outside, elf());
  await assert.rejects(resolveGatewayBinary(source, outside), /OUTSIDE_TARGET/);
  await writeFile(path, Buffer.alloc(64)); await assert.rejects(resolveGatewayBinary(source, path), /REQUIRES_LINUX_AMD64/);
}));
test('symlink executable or symlink target subtree is never staged', async () => fixture(async root => {
  const source = join(root, 'source'); const target = join(source, 'gateway-rs', 'target'); await mkdir(join(target, 'release'), { recursive: true });
  const actual = join(target, 'actual'); await writeFile(actual, elf());
  const linked = join(target, 'release/codeferry-gateway'); await symlink(actual, linked);
  await assert.rejects(resolveGatewayBinary(source, linked), /SYMLINK/);
  await symlink(join(target, 'release'), join(target, 'linked'), 'dir');
  await assert.rejects(resolveGatewayBinary(source, join(target, 'linked/codeferry-gateway')), /SYMLINK/);
}));

test('desktop-only CI release is gated on signed desktop matrix and cannot build or publish gateway', async () => {
 const workflow=await readFile(new URL('../../workflows/desktop-clients.yml',import.meta.url),'utf8');
 assert.match(workflow,/options: \[all, gateway, desktop\]/);
 assert.match(workflow,/inputs\.release_scope != 'desktop'/);
 assert.match(workflow,/needs\.gateway\.result == 'skipped' && inputs\.release_scope == 'desktop'/);
 const desktop=records().filter(row=>row.component==='desktop');
 validateReleaseSet(desktop,{...options,scope:'desktop'});
 assert.throws(()=>validateReleaseSet(desktop.filter(row=>row.format!=='tar.gz'),{...options,scope:'desktop'}),/INCOMPLETE/);
});

test('verification-only flag accepts exact environment booleans and defaults to publication',()=>{
 assert.equal(verificationOnly(undefined),false);assert.equal(verificationOnly('false'),false);assert.equal(verificationOnly('true'),true);
 for(const value of ['',null,true,false,'TRUE','1','0',' true','false ']) assert.throws(()=>verificationOnly(value),/RELEASE_VERIFY_ONLY_INVALID/);
});

test('verification-only executes all six real hashes and four version-bound signatures without network publisher or key',async()=>publicationFixture(async f=>{
 await f.run();assert.equal(f.loads,0);assert.deepEqual(f.calls,[]);assert.deepEqual(f.healthCalls,[]);assert.deepEqual(f.events,[]);assert.deepEqual(f.output,['RELEASE_SET_VERIFIED']);
 // There is deliberately no scripts/publish-release.mjs in the source fixture.
 // Exercise the default dynamic import boundary as well as the observed loader.
 await f.run({loadPublisher:undefined});assert.equal(f.loads,0);assert.deepEqual(f.output,['RELEASE_SET_VERIFIED','RELEASE_SET_VERIFIED']);
}));

test('verification-only rejects any incomplete changed unsigned or mismatched set before publisher access',async()=>{
 const failures=[
  async f=>{const row=records()[0];await rm(join(f.assetDirectory,row.filename));await rm(join(f.assetDirectory,row.filename+'.metadata.json'));},
  async f=>writeFile(join(f.assetDirectory,records()[0].filename),'changed artifact'),
  async f=>{const file=join(f.assetDirectory,records()[1].filename+'.metadata.json');const row=JSON.parse(await readFile(file,'utf8'));row.updaterSignature=signedFixture.signature.slice(1);await writeFile(file,JSON.stringify(row));},
  async f=>{const file=join(f.assetDirectory,records()[0].filename+'.metadata.json');const row=JSON.parse(await readFile(file,'utf8'));row.sourceCommit='c'.repeat(40);await writeFile(file,JSON.stringify(row));},
  async f=>{const file=join(f.assetDirectory,records()[1].filename+'.metadata.json');const row=JSON.parse(await readFile(file,'utf8'));delete row.updaterSignature;await writeFile(file,JSON.stringify(row));},
  async f=>writeFile(join(f.assetDirectory,'unexpected.txt'),'extra'),
 ];
 for(const mutate of failures) await publicationFixture(async f=>{await mutate(f);await assert.rejects(f.run());assert.equal(f.loads,0);assert.deepEqual(f.calls,[]);assert.deepEqual(f.output,[]);});
});

test('verification-only rejects deployment requests before any publisher access',async()=>publicationFixture(async f=>{
 for(const deploy of ['true',undefined,'FALSE','']) {
  f.environment.DEPLOY_GATEWAY=deploy;
  await assert.rejects(f.run(),/RELEASE_VERIFY_ONLY_CANNOT_DEPLOY/);
 }
 assert.equal(f.loads,0);assert.deepEqual(f.calls,[]);assert.deepEqual(f.output,[]);
}));

test('default publication preserves the full verified release set and deploys only gateway when enabled',async()=>publicationFixture(async f=>{
 delete f.environment.VERIFY_ONLY;f.environment.CODEFERRY_PUBLISH_KEY='fixture-not-a-real-publish-key';f.environment.DEPLOY_GATEWAY='true';
 await f.run();assert.equal(f.loads,1);assert.equal(f.calls.length,6);
 assert.deepEqual(f.calls.map(call=>call.metadata.component),['gateway','desktop','desktop','desktop','desktop','desktop']);
 assert.deepEqual(f.calls.map(call=>call.deploy),[true,false,false,false,false,false]);
 assert.deepEqual(f.events,['publish_gateway','health','publish_desktop','publish_desktop','publish_desktop','publish_desktop','publish_desktop']);
 assert.ok(f.calls.every(call=>call.origin===publicationOrigin));assert.equal(f.healthCalls.length,1);assert.equal(String(f.healthCalls[0][0]),publicationOrigin+'/healthz');
 assert.ok(f.calls.every(call=>call.waitDeployment===true));assert.equal(f.output.at(-1),'SERVER_RELEASE_SET_COMPLETE');
 assert.ok(!f.output.includes('RELEASE_SET_VERIFIED'));
}));

test('explicit publish without deployment still publishes gateway and requires a publisher key',async()=>publicationFixture(async f=>{
 f.environment.VERIFY_ONLY='false';await assert.rejects(f.run(),/RELEASE_PUBLISH_CONFIGURATION_INVALID/);assert.equal(f.loads,0);
 f.environment.CODEFERRY_PUBLISH_KEY='fixture-not-a-real-publish-key';await f.run();assert.equal(f.calls.length,6);assert.ok(f.calls.every(call=>call.deploy===false));
}));

test('old unavailable malformed or redirected Gateway blocks every desktop publication after publishing gateway',async()=>{
 const replies=[
  ()=>Response.json({product:'CodeFerry',status:'ok',engine:'gateway-rs',version:'0.2.99'}),
  ()=>new Response('temporarily unavailable',{status:503}),
  ()=>new Response('invalid JSON'),
  ()=>Object.defineProperty(Response.json({product:'CodeFerry',status:'ok',engine:'gateway-rs',version:options.gatewayVersion}),'redirected',{value:true}),
  ()=>{throw Error('untrusted private network diagnostic');},
 ];
 for(const reply of replies) await publicationFixture(async f=>{
  f.environment.VERIFY_ONLY='false';f.environment.CODEFERRY_PUBLISH_KEY='fixture-not-a-real-publish-key';
  await assert.rejects(f.run({healthTransport:async()=>reply()}),{code:'GATEWAY_RELEASE_NOT_READY',message:'GATEWAY_RELEASE_NOT_READY'});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].metadata.component,'gateway');assert.deepEqual(f.output,['RELEASE_COMPONENT_PUBLISHED_GATEWAY']);
 });
});

test('gateway deployment must complete before the health check or any desktop publication',async()=>publicationFixture(async f=>{
 f.environment.VERIFY_ONLY='false';f.environment.CODEFERRY_PUBLISH_KEY='fixture-not-a-real-publish-key';f.environment.DEPLOY_GATEWAY='true';
 const events=[];let finishDeployment;const deployed=new Promise(resolve=>{finishDeployment=resolve;});
 const execution=f.run({loadPublisher:async()=>({publishArtifact:async call=>{events.push('start_'+call.metadata.component);if(call.metadata.component==='gateway'){assert.equal(call.deploy,true);assert.equal(call.waitDeployment,true);await deployed;events.push('gateway_deployed');}}}),
  healthTransport:async()=>{events.push('health');return Response.json({product:'CodeFerry',status:'ok',engine:'gateway-rs',version:options.gatewayVersion});}});
 // Wait for the first effectful call, without releasing its deployment promise.
 for(let attempt=0;!events.length&&attempt<100;attempt++) await new Promise(resolve=>setTimeout(resolve,1));
 assert.deepEqual(events,['start_gateway']);finishDeployment();await execution;
 assert.deepEqual(events,['start_gateway','gateway_deployed','health','start_desktop','start_desktop','start_desktop','start_desktop','start_desktop']);
}));

test('failed gateway deployment retains safe diagnostics and blocks health and desktop publication',async()=>publicationFixture(async f=>{
 Object.assign(f.environment,{VERIFY_ONLY:'false',CODEFERRY_PUBLISH_KEY:'fixture-not-a-real-publish-key',DEPLOY_GATEWAY:'true'});
 const jobId='10000000-0000-4000-8000-000000000003';let publications=0;
 const failure=Object.assign(Error('private response body and credential'),{code:'PUBLISH_DEPLOY_FAILED',stage:'deployment_poll',jobId,status:'failed',errorCode:'DEPLOY_MIGRATION_REVIEW_REQUIRED',response:'private raw body'});
 await assert.rejects(f.run({loadPublisher:async()=>({publishArtifact:async call=>{publications++;assert.equal(call.metadata.component,'gateway');throw failure;}})}),error=>{
  assert.equal(error,failure);
  assert.deepEqual(publicationFailure(error),{error:'PUBLISH_DEPLOY_FAILED',stage:'deployment_poll',jobId,status:'failed',errorCode:'DEPLOY_MIGRATION_REVIEW_REQUIRED'});
  return true;
 });
 assert.equal(publications,1);assert.equal(f.healthCalls.length,0);assert.deepEqual(f.output,[]);
}));

test('publication failure output excludes messages and invalid deployment fields',()=>{
 for(const errorCode of ['DEPLOY_SECRET\ncredential','DEPLOY_SECRET\n','DEPLOY_SECRET\r','DEPLOY_SECRET\u2028','DEPLOY_/private/path','RELEASE_KEY_REVOKED','DEPLOY_lowercase','DEPLOY_'+'A'.repeat(81),{message:'private'}]) {
  const error=Object.assign(Error('credential and arbitrary private server diagnostic'),{code:'PUBLISH_DEPLOY_FAILED',stage:'private/worker/path',jobId:'private credential',status:'private status',errorCode});
  assert.deepEqual(publicationFailure(error),{error:'PUBLISH_DEPLOY_FAILED'});
 }
 assert.deepEqual(publicationFailure(Object.assign(Error('private'),{code:'x'.repeat(101)})),{error:'SERVER_PUBLICATION_FAILED'});
 assert.deepEqual(publicationFailure({code:'PUBLISH_DEPLOY_FAILED\n',jobId:'10000000-0000-4000-8000-000000000003\n'}),{error:'SERVER_PUBLICATION_FAILED'});
 assert.deepEqual(publicationFailure(undefined),{error:'SERVER_PUBLICATION_FAILED'});
});

test('gateway-only publication does not require desktop health and desktop-only requires an already ready gateway',async()=>{
 for(const scope of ['gateway','desktop']) await publicationFixture(async f=>{
  for(const row of records().filter(row=>row.component!==(scope==='gateway'?'gateway':'desktop'))) {
   await rm(join(f.assetDirectory,row.filename));await rm(join(f.assetDirectory,row.filename+'.metadata.json'));
  }
  Object.assign(f.environment,{VERIFY_ONLY:'false',RELEASE_SCOPE:scope,CODEFERRY_PUBLISH_KEY:'fixture-not-a-real-publish-key'});
  await f.run();assert.equal(f.calls.length,scope==='gateway'?1:5);assert.equal(f.healthCalls.length,scope==='gateway'?0:1);
  assert.deepEqual(f.events,scope==='gateway'?['publish_gateway']:['health','publish_desktop','publish_desktop','publish_desktop','publish_desktop','publish_desktop']);
 });
});

test('complete private draft can publish exactly the selected desktop or gateway set',async()=>{
 for(const scope of ['desktop','gateway']) await publicationFixture(async f=>{
  Object.assign(f.environment,{VERIFY_ONLY:'false',RELEASE_SCOPE:scope,CODEFERRY_PUBLISH_KEY:'fixture-not-a-real-publish-key'});
  await f.run();assert.equal(f.calls.length,scope==='desktop'?5:1);
  assert.ok(f.calls.every(call=>call.metadata.component===scope&&call.deploy===false));
  assert.deepEqual(f.events,scope==='desktop'?['health','publish_desktop','publish_desktop','publish_desktop','publish_desktop','publish_desktop']:['publish_gateway']);
  assert.equal(f.output.at(-1),'SERVER_RELEASE_SET_COMPLETE');
 });
});

test('selected verification-only validates the complete private draft without loading a publisher',async()=>{
 for(const scope of ['desktop','gateway']) await publicationFixture(async f=>{
  f.environment.RELEASE_SCOPE=scope;
  await f.run({loadPublisher:undefined});assert.equal(f.loads,0);assert.deepEqual(f.calls,[]);assert.deepEqual(f.healthCalls,[]);assert.deepEqual(f.output,['RELEASE_SET_VERIFIED']);
 });
});

test('corrupt excluded components still block selected publication before publisher access',async()=>{
 const mutations=[
  ['desktop',async f=>writeFile(join(f.assetDirectory,records().find(row=>row.component==='gateway').filename),'changed gateway')],
  ['gateway',async f=>writeFile(join(f.assetDirectory,records()[0].filename),'changed desktop')],
  ['gateway',async f=>{const path=join(f.assetDirectory,records()[1].filename+'.metadata.json');const row=JSON.parse(await readFile(path,'utf8'));row.updaterSignature=signedFixture.signature.slice(1);await writeFile(path,JSON.stringify(row));}],
  ['desktop',async f=>{const path=join(f.assetDirectory,records().find(row=>row.component==='gateway').filename+'.metadata.json');const row=JSON.parse(await readFile(path,'utf8'));row.sourceCommit='c'.repeat(40);await writeFile(path,JSON.stringify(row));}],
 ];
 for(const [scope,mutate] of mutations) await publicationFixture(async f=>{
  Object.assign(f.environment,{VERIFY_ONLY:'false',RELEASE_SCOPE:scope,CODEFERRY_PUBLISH_KEY:'fixture-not-a-real-publish-key'});await mutate(f);
  await assert.rejects(f.run());assert.equal(f.loads,0);assert.deepEqual(f.calls,[]);assert.deepEqual(f.healthCalls,[]);assert.deepEqual(f.output,[]);
 });
});

test('selected publication refuses incomplete mixed sets unknown components and extra files',async()=>{
 const mutations=[
  async f=>{const row=records()[0];await rm(join(f.assetDirectory,row.filename));await rm(join(f.assetDirectory,row.filename+'.metadata.json'));},
  async f=>{const row=records().find(row=>row.component==='gateway');await rm(join(f.assetDirectory,row.filename+'.metadata.json'));},
  async f=>{const path=join(f.assetDirectory,records().find(row=>row.component==='gateway').filename+'.metadata.json');const row=JSON.parse(await readFile(path,'utf8'));row.component='unknown';await writeFile(path,JSON.stringify(row));},
  async f=>writeFile(join(f.assetDirectory,'unexpected.txt'),'extra'),
 ];
 for(const scope of ['desktop','gateway']) for(const mutate of mutations) await publicationFixture(async f=>{
  Object.assign(f.environment,{VERIFY_ONLY:'false',RELEASE_SCOPE:scope,CODEFERRY_PUBLISH_KEY:'fixture-not-a-real-publish-key'});await mutate(f);
  await assert.rejects(f.run());assert.equal(f.loads,0);assert.deepEqual(f.calls,[]);assert.deepEqual(f.healthCalls,[]);assert.deepEqual(f.output,[]);
 });
});

test('invalid requested publication scope is refused even for complete verification-only drafts',async()=>{
 for(const scope of ['invalid','', 'Desktop']) await publicationFixture(async f=>{
  f.environment.RELEASE_SCOPE=scope;
  await assert.rejects(f.run(),/RELEASE_BUILD_CONFIGURATION_INVALID/);assert.equal(f.loads,0);assert.deepEqual(f.calls,[]);assert.deepEqual(f.output,[]);
 });
});

test('gateway readiness checks only the fixed HTTPS authority or explicit literal loopback, with no redirects or credentials',async()=>{
 const calls=[];const transport=async(...args)=>{calls.push(args);return Response.json({product:'CodeFerry',status:'ok',engine:'gateway-rs',version:options.gatewayVersion});};
 await requireReadyGateway(options.gatewayVersion,{transport});assert.equal(String(calls[0][0]),publicationOrigin+'/healthz');
 assert.equal(calls[0][1].method,'GET');assert.equal(calls[0][1].redirect,'error');assert.ok(calls[0][1].signal instanceof AbortSignal);assert.equal(calls[0][1].headers,undefined);
 await requireReadyGateway(options.gatewayVersion,{transport,origin:'http://127.0.0.1:39001',allowLoopback:true});
 for(const origin of ['https://example.com','https://codeferry.link/','http://codeferry.link','http://localhost:39001','http://127.0.0.1:39001','https://user:password@codeferry.link','https://codeferry.link/path','https://codeferry.link?query=true']) {
  await assert.rejects(requireReadyGateway(options.gatewayVersion,{origin,transport}),{code:'GATEWAY_RELEASE_NOT_READY'});
 }
 assert.equal(calls.length,2);
});

test('gateway readiness requires the exact product status engine version and bounded valid UTF8 JSON',async()=>{
 const valid={product:'CodeFerry',status:'ok',engine:'gateway-rs',version:options.gatewayVersion};
 for(const edit of [{product:'Other'},{status:'starting'},{engine:'node'},{version:'0.3.1'},{version:undefined}]) {
  await assert.rejects(requireReadyGateway(options.gatewayVersion,{transport:async()=>Response.json({...valid,...edit})}),{code:'GATEWAY_RELEASE_NOT_READY'});
 }
 for(const bytes of [' '.repeat(16*1024+1),Buffer.from([0xff,0xfe]),'not JSON','null','[]']) {
  await assert.rejects(requireReadyGateway(options.gatewayVersion,{transport:async()=>new Response(bytes)}),{code:'GATEWAY_RELEASE_NOT_READY'});
 }
 let cancelled=false;
 const body=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(16*1024+1));},cancel(){cancelled=true;}});
 await assert.rejects(requireReadyGateway(options.gatewayVersion,{transport:async()=>new Response(body)}),{code:'GATEWAY_RELEASE_NOT_READY'});assert.equal(cancelled,true);
 await assert.rejects(requireReadyGateway(options.gatewayVersion,{transport:async()=>({ok:true,redirected:false,url:'https://example.com/healthz',body:new Response('{}').body})}),{code:'GATEWAY_RELEASE_NOT_READY'});
});
