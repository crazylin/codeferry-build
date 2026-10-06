import { createReadStream, constants } from 'node:fs';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
export async function identity(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 2 * 1024 ** 3) throw Error('ASSET_SIZE_INVALID');
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
  if (bytes !== info.size) throw Error('ASSET_CHANGED');
  return { size: bytes, sha256: hash.digest('hex') };
}
export function targetFor(platform, arch) { return ({'darwin:arm64':'darwin-aarch64','win32:x64':'windows-x86_64','linux:x64':'linux-x86_64'})[platform + ':' + arch]; }
export function artifactName(version, platform, arch, format) { return `CodeFerry-${version}-${platform}-${arch}${format === 'tar.gz' ? '.app.tar.gz' : '.' + format}`; }
export function expectedMetadata(component, version, platform, arch, variant, filename, sourceCommit, format = 'tar.gz', signature) {
  if (!VERSION.test(version) || !/^[a-f0-9]{40}$/.test(sourceCommit) || !targetFor(platform, arch) || variant !== 'full' || !['desktop','gateway'].includes(component)) throw Error('ASSET_METADATA_INVALID');
  const updater = component === 'desktop' && ['tar.gz','exe','AppImage'].includes(format);
  return { component, version, platform, arch, variant, filename, sourceCommit, channel: 'stable', clientEngine: component === 'desktop' ? 'tauri' : 'native',
    format, notes: 'CodeFerry verified build ' + sourceCommit.slice(0, 12), ...(updater ? {updaterSignature:signature, updateTarget:targetFor(platform,arch)} : {}) };
}
function decoded(value, maximum) {
  if (typeof value !== 'string' || value.length > maximum || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw Error('ASSET_SIGNATURE_INVALID');
  const bytes = Buffer.from(value, 'base64'); if (bytes.toString('base64') !== value) throw Error('ASSET_SIGNATURE_INVALID'); return bytes;
}
export async function verifyTauriSignature(file, encodedSignature, encodedKey, version) {
  const lines = decoded(encodedSignature, 4096).toString('utf8').trimEnd().split('\n');
  const keys = decoded(encodedKey.trim(), 4096).toString('utf8').trimEnd().split('\n');
  if (lines.length !== 4 || !lines[0].startsWith('untrusted comment: ') || !lines[2].startsWith('trusted comment: ') || keys.length !== 2) throw Error('ASSET_SIGNATURE_INVALID');
  const raw = decoded(lines[1], 200), pub = decoded(keys[1], 200), global = decoded(lines[3], 200);
  const comment = lines[2].slice(17);
  if (raw.length !== 74 || pub.length !== 42 || global.length !== 64 || raw.subarray(0,2).toString() !== 'ED' || pub.subarray(0,2).toString() !== 'Ed' || !raw.subarray(2,10).equals(pub.subarray(2,10)) || comment.split('\t').filter(field => field.startsWith('version:')).join('') !== 'version:' + version) throw Error('ASSET_SIGNATURE_INVALID');
  const hash = createHash('blake2b512'); for await (const chunk of createReadStream(file)) hash.update(chunk);
  const key = createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),pub.subarray(10)]),format:'der',type:'spki'});
  if (!verify(null, hash.digest(), key, raw.subarray(10)) || !verify(null, Buffer.concat([raw.subarray(10),Buffer.from(comment)]), key, global)) throw Error('ASSET_SIGNATURE_INVALID');
}
export async function writeMetadata(file, metadata) {
  const info = await identity(file);
  await writeFile(file + '.metadata.json', JSON.stringify({ ...metadata, ...info }, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); return info;
}
async function installerFiles(bundle, platform) {
  const directories = { darwin: ['dmg', 'macos'], win32: ['nsis'], linux: ['appimage', 'deb'] }[platform];
  const root = await lstat(bundle);
  if (!root.isDirectory() || root.isSymbolicLink()) throw Error('ASSET_BUNDLE_INVALID');
  const files = [];
  for (const directory of directories) {
    const path = join(bundle, directory), info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error('ASSET_BUNDLE_INVALID');
    const entries = await readdir(path, { withFileTypes: true });
    if (entries.length > 256) throw Error('ASSET_BUNDLE_INVALID');
    // Tauri leaves AppDir and Debian staging trees beside finished installers.
    // Installer discovery is limited to the documented bundle directory itself.
    for (const entry of entries) {
      if (!/\.(?:dmg|app\.tar\.gz|exe|AppImage|deb)$/.test(entry.name)) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) throw Error('ASSET_BUNDLE_INVALID');
      files.push(join(path, entry.name));
    }
  }
  return files;
}
export async function collectTauri(source, platform = process.platform, arch = process.arch, destination = process.env.ASSET_DIR, sourceCommit = process.env.SOURCE_SHA) {
  const root=resolve(source), pkg=JSON.parse(await readFile(join(root,'desktop-tauri/package.json'),'utf8'));
  if(!VERSION.test(pkg.version) || !targetFor(platform,arch) || !destination) throw Error('ASSET_ARGUMENT_INVALID');
  if(platform==='darwin') await verifyMacBundle(root, join(root,'desktop-tauri/src-tauri/target/release/bundle/macos/CodeFerry.app'),pkg.version);
  const files=await installerFiles(join(root,'desktop-tauri/src-tauri/target/release/bundle'),platform);
  const formats=platform==='darwin'?['dmg','tar.gz']:platform==='win32'?['exe']:['AppImage','deb'];
  const pub=await readFile(join(root,'desktop-tauri/updater.pub'),'utf8');
  await mkdir(destination,{recursive:true,mode:0o700});
  for(const format of formats) {
    const suffix=format==='tar.gz'?'.app.tar.gz':'.'+format;
    const candidates=files.filter(file=>file.endsWith(suffix)); if(candidates.length!==1) throw Error('ASSET_BUNDLE_SET_INVALID');
    const file=candidates[0], updater=['tar.gz','exe','AppImage'].includes(format);
    let signature; if(updater) { const info=await lstat(file+'.sig'); if(!info.isFile()||info.isSymbolicLink()||info.size<1||info.size>4096) throw Error('ASSET_SIGNATURE_INVALID'); signature=(await readFile(file+'.sig','utf8')).trim(); await verifyTauriSignature(file,signature,pub,pkg.version); }
    const name=artifactName(pkg.version,platform,arch,format), output=join(destination,name);
    await copyFile(file,output,constants.COPYFILE_EXCL);
    const metadata=expectedMetadata('desktop',pkg.version,platform,arch,'full',name,sourceCommit,format,signature);
    const actual=await writeMetadata(output,metadata); if(actual.size>512*1024**2) throw Error('ASSET_DESKTOP_TOO_LARGE');
  }
}
async function main() { if(process.argv[2]!=='tauri') throw Error('ASSET_COMMAND_INVALID'); await collectTauri(process.argv[3]); console.log('TAURI_RELEASE_ASSETS_VERIFIED'); }
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(()=>{console.error('RELEASE_ASSET_PREPARATION_FAILED');process.exitCode=1;});

export async function verifyMacBundle(root, application, version) {
 const native=join(application,'Contents/Resources/native'), runner=join(native,'codeferry-runner');
 const manifest=JSON.parse(await readFile(join(native,'BUILD_INFO.json'),'utf8'));
 const origin=JSON.parse(await readFile(join(root,'runtime/BUILD_INFO.json'),'utf8'));
 const metadata=JSON.parse(await readFile(join(native,'CodeFerry-BUILD_INFO.json'),'utf8'));
 if(JSON.stringify(manifest)!==JSON.stringify(origin)||JSON.stringify(metadata.native)!==JSON.stringify(origin)||metadata.version!==version||metadata.clientEngine!=='tauri') throw Error('ASSET_BUNDLED_RUNNER_IDENTITY_INVALID');
 const actual=await identity(runner);if(actual.sha256!==manifest.sha256['codeferry-runner']) throw Error('ASSET_BUNDLED_RUNNER_HASH_INVALID');
 const report=JSON.parse(execFileSync(runner,['--build-info-json'],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','ignore']}));
 if(JSON.stringify(report)!==JSON.stringify(manifest.binaries['webcodex-runner'])) throw Error('ASSET_BUNDLED_RUNNER_IDENTITY_INVALID');
 execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',application],{stdio:['ignore','pipe','ignore'],timeout:30000});
}
