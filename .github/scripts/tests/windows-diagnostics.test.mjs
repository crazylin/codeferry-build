import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedWindowsIdentity } from '../diagnostic-file-identity.mjs';
import { diagnosticExitCode } from '../task-exit-code.mjs';
import { collectDiagnostics } from '../save-private-diagnostics.mjs';
import { mkdtemp, writeFile, link, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const info = {dev:0n,ino:19421773395341797n,nlink:1n,isFile:()=>true,isDirectory:()=>false,isSymbolicLink:()=>false};
const native = {dev:'2162558900',ino:'19421773395341797',nlink:'1',directory:false,reparse:false};
test('Windows diagnostics retain exact inode and native volume identity rather than ignoring dev', () => {
  const result=checkedWindowsIdentity(info,native);assert.equal(result.dev,2162558900n);assert.equal(result.ino,info.ino);assert.ok(result.isFile());
  for(const changed of [{ino:'19421773395341796'},{nlink:'2'},{reparse:true},{directory:true},{dev:'4294967296'},{ino:'0'}]) assert.throws(()=>checkedWindowsIdentity(info,{...native,...changed}),/IDENTITY_INVALID/);
  assert.throws(()=>checkedWindowsIdentity({...info,dev:123n},native),/IDENTITY_INVALID/);
});
test('full Windows exit statuses survive signed or unsigned Node results; other platforms remain bounded',()=>{
  assert.equal(diagnosticExitCode(-1073741510,'win32'),3221225786);
  assert.equal(diagnosticExitCode(3221225477,'win32'),3221225477);
  assert.equal(diagnosticExitCode(101,'win32'),101);
  for(const value of [null,undefined,NaN,Infinity,1.1,-2147483649,4294967296,'SECRET']) assert.equal(diagnosticExitCode(value,'win32'),'none');
  assert.equal(diagnosticExitCode(3221225477,'linux'),'none');assert.equal(diagnosticExitCode(101,'linux'),101);
});
test('Windows real filesystem keeps hardlink and junction rejection', {skip:process.platform!=='win32'}, async()=>{
  const root=await mkdtemp(join(tmpdir(),'private-windows-diagnostics-'));
  try {
    const logs=join(root,'logs');await mkdir(logs);const source=join(root,'secret');await writeFile(source,'SECRET');
    await link(source,join(logs,'tauri-contracts.log'));
    await assert.rejects(collectDiagnostics(logs,{}),/PRIVATE_DIAGNOSTIC_FILE_INVALID/);
    await symlink(logs,join(root,'junction'),'junction');
    await assert.rejects(collectDiagnostics(join(root,'junction'),{}),/PRIVATE_DIAGNOSTIC_DIRECTORY_INVALID/);
  } finally {await rm(root,{recursive:true,force:true});}
});
