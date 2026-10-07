import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {isDeepStrictEqual} from 'node:util';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function bytes(response, limit) {
  if (!response.ok || !response.body) throw Error('FINGERPRINT_HTTP_INVALID');
  const chunks=[];let length=0;
  for await (const part of response.body) {
    length+=part.length;
    if(length>limit) {throw Error('FINGERPRINT_RESPONSE_TOO_LARGE');}
    chunks.push(part);
  }
  return Buffer.concat(chunks,length);
}
export async function verifyFingerprintDistribution(origin, manifestPath) {
  const expected=JSON.parse(await readFile(manifestPath,'utf8'));
  if(!Number.isSafeInteger(expected.size)||expected.size<1||expected.size>16*1024**2||
     !Number.isSafeInteger(expected.uncompressedSize)||expected.uncompressedSize<1||expected.uncompressedSize>64*1024**2||
     !/^\/api\/fingerprints\/[a-zA-Z0-9._-]+\/bundle$/.test(expected.url)) throw Error('FINGERPRINT_EXPECTED_MANIFEST_INVALID');
  const options=()=>({redirect:'error',signal:AbortSignal.timeout(30000)});
  const manifest=await fetch(new URL('/api/fingerprints/manifest',origin),options());
  const actual=JSON.parse((await bytes(manifest,16384)).toString('utf8'));
  if(!isDeepStrictEqual(actual,expected)) throw Error('FINGERPRINT_MANIFEST_MISMATCH');
  const response=await fetch(new URL(expected.url,origin),options());
  if(response.headers.has('content-encoding')||!response.headers.get('content-type')?.startsWith('application/gzip')||
     !response.headers.get('cache-control')?.includes('immutable')) throw Error('FINGERPRINT_BUNDLE_HEADERS_INVALID');
  const etag=response.headers.get('etag');
  if(!etag) throw Error('FINGERPRINT_ETAG_MISSING');
  const compressed=await bytes(response,expected.size);
  if(compressed.length!==expected.size||sha(compressed)!==expected.sha256) throw Error('FINGERPRINT_COMPRESSED_IDENTITY_INVALID');
  const raw=gunzipSync(compressed,{maxOutputLength:expected.uncompressedSize});
  if(raw.length!==expected.uncompressedSize||sha(raw)!==expected.uncompressedSha256) throw Error('FINGERPRINT_RAW_IDENTITY_INVALID');
  const conditional=await fetch(new URL(expected.url,origin),{...options(),headers:{'If-None-Match':etag}});
  if(conditional.status!==304) {await conditional.body?.cancel();throw Error('FINGERPRINT_CONDITIONAL_GET_INVALID');}
  return {version:expected.version,size:compressed.length,modelCount:expected.modelCount};
}
