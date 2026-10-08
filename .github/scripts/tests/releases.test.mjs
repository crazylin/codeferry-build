import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectedMetadata, artifactName, writeMetadata, verifyTauriSignature } from '../assets.mjs';
import { requireProductionEngine, validateReleaseSet } from '../publish-server.mjs';
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
