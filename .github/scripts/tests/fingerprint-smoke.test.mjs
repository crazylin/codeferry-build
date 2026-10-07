import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {verifyFingerprintDistribution} from '../fingerprint-smoke.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
async function fixture(mode,run) {
 const raw=Buffer.from('{"fixture":true}'),blob=gzipSync(raw);
 const manifest={version:'fixture-v1',url:'/api/fingerprints/fixture-v1/bundle',size:blob.length,sha256:sha(blob),uncompressedSize:raw.length,uncompressedSha256:sha(raw),modelCount:1};
 const directory=await mkdtemp(join(tmpdir(),'cf-fingerprint-smoke-'));const file=join(directory,'manifest.json');await writeFile(file,JSON.stringify(manifest));
 const server=createServer((req,res)=>{
  if(req.url==='/api/fingerprints/manifest') {res.setHeader('content-type','application/json');res.end(JSON.stringify(mode==='manifest-mismatch'?{...manifest,modelCount:2}:manifest));return;}
  if(req.url!==manifest.url){res.writeHead(404).end();return;}
  if(req.headers['if-none-match']&&mode!=='no-304'){res.writeHead(304).end();return;}
  res.setHeader('content-type',mode==='bad-header'?'text/plain':'application/gzip');
  res.setHeader('cache-control','public, max-age=31536000, immutable');
  if(mode!=='no-etag')res.setHeader('etag','"fixture"');
  res.end(mode==='tamper'?Buffer.alloc(blob.length):mode==='oversized'?Buffer.concat([blob,Buffer.from('x')]):blob);
 });
 try {await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));await run('http://127.0.0.1:'+server.address().port,file);}
 finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
}
test('fingerprint distribution checks exact manifest, both byte identities and conditional cache',async()=>{
 await fixture('valid',async(origin,path)=>assert.deepEqual(await verifyFingerprintDistribution(origin,path),{version:'fixture-v1',size:gzipSync(Buffer.from('{"fixture":true}')).length,modelCount:1}));
});
test('fingerprint distribution rejects incorrect and unbounded replies',async()=>{
 for(const mode of ['manifest-mismatch','bad-header','no-etag','tamper','oversized','no-304']) await fixture(mode,async(origin,path)=>assert.rejects(verifyFingerprintDistribution(origin,path)));
});
