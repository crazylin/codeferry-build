import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectTauri } from '../assets.mjs';

const version = '0.2.1', sourceCommit = 'a'.repeat(40);

async function fixture(body) {
  const root = await mkdtemp(join(tmpdir(), 'codeferry-tauri-installers-'));
  try {
    const desktop = join(root, 'desktop-tauri');
    const bundle = join(desktop, 'src-tauri/target/release/bundle');
    const appimage = join(bundle, 'appimage', `CodeFerry_${version}_amd64.AppImage`);
    const deb = join(bundle, 'deb', `code-ferry_${version}_amd64.deb`);
    const destination = join(root, 'assets');
    await mkdir(join(bundle, 'appimage'), { recursive: true });
    await mkdir(join(bundle, 'deb'), { recursive: true });
    await writeFile(join(desktop, 'package.json'), JSON.stringify({ version }));
    const bytes = Buffer.from('CodeFerry Linux installer test bytes');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const keyId = Buffer.alloc(8, 3);
    const publicPacket = Buffer.concat([Buffer.from('Ed'), keyId, publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)]);
    const signature = sign(null, createHash('blake2b512').update(bytes).digest(), privateKey);
    const comment = `timestamp:1\tfile:fixture.AppImage\tversion:${version}`;
    const signaturePacket = Buffer.concat([Buffer.from('ED'), keyId, signature]);
    const encodedSignature = Buffer.from(`untrusted comment: test fixture\n${signaturePacket.toString('base64')}\ntrusted comment: ${comment}\n${sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey).toString('base64')}\n`).toString('base64');
    await writeFile(join(desktop, 'updater.pub'), Buffer.from(`untrusted comment: test fixture\n${publicPacket.toString('base64')}\n`).toString('base64'));
    await writeFile(appimage, bytes);
    await writeFile(appimage + '.sig', encodedSignature);
    await writeFile(deb, bytes);
    await writeFile(deb + '.sig', encodedSignature);
    await body({ root, bundle, appimage, deb, destination });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('collects verified top-level Linux installers while ignoring native AppDir and Debian staging', async () => fixture(async f => {
  for (const path of [
    'appimage/CodeFerry.AppDir/usr/lib/webkit2gtk-4.1/injected-bundle',
    'deb/code-ferry_0.2.1_amd64/data/usr/share/codeferry/native/licenses/test',
  ]) {
    const nested = join(f.bundle, path);
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'nested.deb'), 'staging file, not an installer');
  }
  await collectTauri(f.root, 'linux', 'x64', f.destination, sourceCommit);
  const names = (await readdir(f.destination)).sort();
  assert.deepEqual(names, [
    'CodeFerry-0.2.1-linux-x64.AppImage',
    'CodeFerry-0.2.1-linux-x64.AppImage.metadata.json',
    'CodeFerry-0.2.1-linux-x64.deb',
    'CodeFerry-0.2.1-linux-x64.deb.metadata.json',
  ]);
  const metadata = JSON.parse(await readFile(join(f.destination, names[1]), 'utf8'));
  assert.equal(metadata.updateTarget, 'linux-x86_64-appimage');
  const debMetadata=JSON.parse(await readFile(join(f.destination,names[3]),'utf8'));assert.equal(debMetadata.updateTarget,'linux-x86_64-deb');assert.ok(debMetadata.updaterSignature);
  assert.equal(metadata.sourceCommit, sourceCommit);
  assert.equal(metadata.sha256, createHash('sha256').update(await readFile(f.appimage)).digest('hex'));
  await assert.rejects(collectTauri(f.root, 'linux', 'x64', f.destination, sourceCommit), { code: 'EEXIST' });
}));

test('duplicate and missing top-level installers are refused despite staged lookalikes', async () => fixture(async f => {
  const duplicate = join(f.bundle, 'appimage', 'duplicate.AppImage');
  await writeFile(duplicate, 'unexpected duplicate');
  await assert.rejects(collectTauri(f.root, 'linux', 'x64', f.destination, sourceCommit), /ASSET_BUNDLE_SET_INVALID/);
  await rm(duplicate);
  await rm(f.appimage);
  const nested = join(f.bundle, 'appimage/CodeFerry.AppDir/usr/bin');
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, 'lookalike.AppImage'), 'not a top-level installer');
  await assert.rejects(collectTauri(f.root, 'linux', 'x64', f.destination, sourceCommit), /ASSET_BUNDLE_SET_INVALID/);
}));

test('symlinked bundle directory, installer and signature are refused', async () => fixture(async f => {
  const actual = join(f.root, 'actual.AppImage');
  await writeFile(actual, await readFile(f.appimage));
  await rm(f.appimage);
  await symlink(actual, f.appimage);
  await assert.rejects(collectTauri(f.root, 'linux', 'x64', f.destination, sourceCommit), /ASSET_BUNDLE_INVALID/);
  await rm(f.appimage);
  await writeFile(f.appimage, await readFile(actual));
  const signature = f.appimage + '.sig', actualSignature = join(f.root, 'actual.sig');
  await writeFile(actualSignature, await readFile(signature));
  await rm(signature);
  await symlink(actualSignature, signature);
  await assert.rejects(collectTauri(f.root, 'linux', 'x64', f.destination, sourceCommit), /ASSET_SIGNATURE_INVALID/);
  await rm(join(f.bundle, 'appimage'), { recursive: true });
  await symlink(f.root, join(f.bundle, 'appimage'), 'dir');
  await assert.rejects(collectTauri(f.root, 'linux', 'x64', f.destination, sourceCommit), /ASSET_BUNDLE_INVALID/);
}));

test('installer-directory discovery is bounded', async () => fixture(async f => {
  await Promise.all(Array.from({ length: 255 }, (_, index) => writeFile(join(f.bundle, 'appimage', `staging-${index}`), '')));
  await assert.rejects(collectTauri(f.root, 'linux', 'x64', f.destination, sourceCommit), /ASSET_BUNDLE_INVALID/);
}));

test('unsigned Debian installer is refused before publication',async()=>fixture(async f=>{await rm(f.deb+'.sig');await assert.rejects(collectTauri(f.root,'linux','x64',f.destination,sourceCommit));}));
