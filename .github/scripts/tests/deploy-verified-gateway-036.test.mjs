import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAN, verifyMetadata } from '../deploy-verified-gateway-036.mjs';
const meta = () => ({
  version:PLAN.version,filename:PLAN.filename,size:PLAN.size,
  sha256:PLAN.sha256,component:'gateway',platform:'linux',arch:'x64',
  format:'tar.gz',channel:'stable',clientEngine:'native',
  sourceCommit:PLAN.source,
});
test('exact published release metadata passes',()=>assert.doesNotThrow(()=>verifyMetadata(meta())));
test('modified version, sha or source fails closed',()=>{
  for(const [field,value] of [['version','0.3.7'],['sha256','invalid'],['sourceCommit','other'],['size',1]])
    assert.throws(()=>verifyMetadata({...meta(),[field]:value}));
});
