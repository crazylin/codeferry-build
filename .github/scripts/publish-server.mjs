import { readdir, readFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { identity, artifactName, targetFor, verifyTauriSignature } from './assets.mjs';
export const publicationOrigin='https://codeferry.link';
export function requireProductionEngine(engine='tauri') { if(engine!=='tauri') throw Error('CLIENT_ENGINE_INVALID'); }
export function validateReleaseSet(records,{sourceSha,desktopVersion,gatewayVersion,scope='all'}) {
  const version=/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
  if(!['all','gateway','desktop'].includes(scope)||!/^[a-f0-9]{40}$/.test(sourceSha??'')||![desktopVersion,gatewayVersion].every(v=>version.test(v??''))) throw Error('RELEASE_BUILD_CONFIGURATION_INVALID');
  const required=new Set(scope==='desktop'?[]:['gateway:linux:x64:tar.gz']);
  if(scope!=='gateway') for(const [platform,arch,formats] of [['darwin','arm64',['dmg','tar.gz']],['win32','x64',['exe']],['linux','x64',['AppImage','deb']]]) for(const format of formats) required.add(['desktop',platform,arch,format].join(':'));
  if(records.length!==required.size) throw Error('RELEASE_BUILD_SET_INCOMPLETE');
  for(const row of records) {
    const gateway=row.component==='gateway', expectedVersion=gateway?gatewayVersion:desktopVersion;
    const name=gateway?`CodeFerry-gateway-${gatewayVersion}-linux-x64.tar.gz`:artifactName(desktopVersion,row.platform,row.arch,row.format);
    const updater=!gateway && ['tar.gz','exe','AppImage','deb'].includes(row.format);
    if(!required.delete([row.component,row.platform,row.arch,row.format].join(':')) || row.version!==expectedVersion || row.sourceCommit!==sourceSha || row.filename!==name || row.channel!=='stable' || row.variant!=='full' || row.clientEngine!==(gateway?'native':'tauri') || !Number.isSafeInteger(row.size) || row.size<1 || row.size>(gateway?2*1024**3:512*1024**2) || !/^[a-f0-9]{64}$/.test(row.sha256??'') || (updater && (typeof row.updaterSignature!=='string'||row.updaterSignature.length<64||row.updaterSignature.length>4096||row.updateTarget!==targetFor(row.platform,row.arch,row.format))) || (!updater && (row.updaterSignature!==undefined||row.updateTarget!==undefined))) throw Error('RELEASE_BUILD_SET_INVALID');
  }
}
export function verificationOnly(value) {
  if(value===undefined||value==='false') return false;
  if(value==='true') return true;
  throw Error('RELEASE_VERIFY_ONLY_INVALID');
}
export async function requireReadyGateway(version,{origin=publicationOrigin,transport=fetch,allowLoopback=false}={}) {
  try {
    const base=new URL(origin);
    // Production publication has one fixed authority, shared with publishArtifact.
    // A literal loopback HTTP authority is admitted only by explicit test input.
    if(base.origin!==origin||base.username||base.password||!(origin===publicationOrigin||
      (allowLoopback&&base.protocol==='http:'&&base.hostname==='127.0.0.1'))||
      !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version??'')) throw Error();
    const target=new URL('/healthz',base);
    const response=await transport(target,{method:'GET',redirect:'error',signal:AbortSignal.timeout(5000)});
    if(!response.ok||response.redirected||(response.url&&response.url!==target.href)||!response.body) throw Error();
    const chunks=[];let bytes=0;const reader=response.body.getReader();
    try {
      for(;;) {
        const part=await reader.read();if(part.done) break;
        bytes+=part.value.byteLength;if(bytes>16*1024) {await reader.cancel();throw Error();}
        chunks.push(Buffer.from(part.value));
      }
    } finally {reader.releaseLock();}
    const health=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
    if(health?.product!=='CodeFerry'||health.status!=='ok'||health.engine!=='gateway-rs'||health.version!==version) throw Error();
  } catch {throw Object.assign(Error('GATEWAY_RELEASE_NOT_READY'),{code:'GATEWAY_RELEASE_NOT_READY'});}
}
export async function runPublication({environment=process.env,sourceRoot=resolve('source'),assetDirectory=environment.ASSET_DIR,
  loadPublisher=source=>import(pathToFileURL(join(source,'scripts/publish-release.mjs'))),healthTransport=fetch,log=value=>console.log(value)}={}) {
  const verifyOnly=verificationOnly(environment.VERIFY_ONLY);
  if(verifyOnly&&environment.DEPLOY_GATEWAY!=='false') throw Error('RELEASE_VERIFY_ONLY_CANNOT_DEPLOY');
  requireProductionEngine(environment.CLIENT_ENGINE??'tauri');
  const source=resolve(sourceRoot);
  const sourceSha=environment.SOURCE_SHA;
  if(!/^[a-f0-9]{40}$/.test(sourceSha??'')||typeof assetDirectory!=='string'||!assetDirectory||(!verifyOnly&&!environment.CODEFERRY_PUBLISH_KEY)) throw Error('RELEASE_PUBLISH_CONFIGURATION_INVALID');
  const directory=resolve(assetDirectory);
  const desktopVersion=JSON.parse(await readFile(join(source,'desktop-tauri/package.json'),'utf8')).version;
  const gatewayVersion=(await readFile(join(source,'gateway-rs/Cargo.toml'),'utf8')).match(/^version\s*=\s*"(\d+\.\d+\.\d+)"/m)?.[1];
  const pub=await readFile(join(source,'desktop-tauri/updater.pub'),'utf8'); const files=await readdir(directory), records=[];
  for(const name of files.filter(name=>name.endsWith('.metadata.json'))) {
    const raw=await readFile(join(directory,name),'utf8');if(Buffer.byteLength(raw)>32*1024) throw Error('RELEASE_METADATA_INVALID'); const row=JSON.parse(raw);
    if(name!==row.filename+'.metadata.json'||!/^[A-Za-z0-9_.-]{1,180}$/.test(row.filename??'')) throw Error('RELEASE_METADATA_INVALID');
    const file=join(directory,row.filename);if((await lstat(file)).isSymbolicLink()) throw Error('RELEASE_ASSET_INVALID');const actual=await identity(file);
    if(actual.size!==row.size||actual.sha256!==row.sha256) throw Error('RELEASE_ASSET_CHANGED');
    if(row.updaterSignature) await verifyTauriSignature(file,row.updaterSignature,pub,row.version); records.push(row);
  }
  validateReleaseSet(records,{sourceSha,desktopVersion,gatewayVersion,scope:environment.RELEASE_SCOPE??'all'});
  if(files.length!==records.length*2) throw Error('RELEASE_ASSET_SET_INVALID');
  // Verification uses the same complete set, byte hashes and updater signatures
  // as publication. Do not even load the effectful publisher for a build draft.
  if(verifyOnly) { log('RELEASE_SET_VERIFIED'); return; }
  const {publishArtifact}=await loadPublisher(source);
  records.sort((a,b)=>(a.component==='gateway'?0:1)-(b.component==='gateway'?0:1)||a.filename.localeCompare(b.filename));
  let desktopReady=false;
  for(const row of records) {
    if(row.component==='desktop'&&!desktopReady) {
      await requireReadyGateway(gatewayVersion,{origin:publicationOrigin,transport:healthTransport});desktopReady=true;
    }
    await publishArtifact({file:join(directory,row.filename),metadata:row,key:environment.CODEFERRY_PUBLISH_KEY,origin:publicationOrigin,
      deploy:row.component==='gateway'&&environment.DEPLOY_GATEWAY!=='false',waitDeployment:true});
    log('RELEASE_COMPONENT_PUBLISHED_'+row.component.toUpperCase());
  }
  log('SERVER_RELEASE_SET_COMPLETE');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) runPublication().catch(error=>{console.error(typeof error.code==='string'&&/^[A-Z_0-9]+$/.test(error.code)?error.code:'SERVER_PUBLICATION_FAILED');process.exitCode=1;});
