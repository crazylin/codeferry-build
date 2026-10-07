import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,lstat,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {identity,verifyTauriSignature} from './assets.mjs';
export async function signDebian(file,source,version){
 assert.match(version,/^\d+\.\d+\.\d+$/);assert.ok(file.endsWith('.deb'));
 const before=await identity(file),pub=await readFile(join(source,'desktop-tauri/updater.pub'),'utf8');
 let exists=false;try{const s=await lstat(file+'.sig');assert.ok(s.isFile()&&!s.isSymbolicLink()&&s.size<=4096);exists=true;}catch(e){if(e.code!=='ENOENT')throw e;}
 if(!exists){assert.ok(process.env.TAURI_SIGNING_PRIVATE_KEY?.trim());execFileSync(process.execPath,[join(source,'desktop-tauri/node_modules/@tauri-apps/cli/tauri.js'),'signer','sign','--app-version',version,file],{cwd:source,env:process.env,stdio:'ignore',timeout:60000});}
 const signature=(await readFile(file+'.sig','utf8')).trim();await verifyTauriSignature(file,signature,pub,version);assert.deepEqual(await identity(file),before);return signature;
}
async function main(){const source=resolve('source'),dir=join(source,'desktop-tauri/src-tauri/target/release/bundle/deb');const files=(await readdir(dir)).filter(n=>n.endsWith('.deb'));assert.equal(files.length,1);const version=JSON.parse(await readFile(join(source,'desktop-tauri/package.json'),'utf8')).version;await signDebian(join(dir,files[0]),source,version);console.log('DEBIAN_OFFICIAL_SIGNATURE_VERIFIED');}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('DEBIAN_SIGNATURE_FAILED');process.exitCode=1;});
