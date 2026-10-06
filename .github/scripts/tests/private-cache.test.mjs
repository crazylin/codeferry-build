import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, cp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { cacheKey, tagFor, partsFor, validateManifest, validateRelease, savePart, restorePart, fileIdentity,
  archive, runCache, MAX_ARCHIVE, MAX_EXPANDED, githubTransport, normalizeDesktopInputs } from '../private-cache.mjs';

const bucket = 'gateway-linux-x64', part = 'gateway-release', key = 'a'.repeat(64), sourceSha = 'b'.repeat(40);
const target = 'gateway-rs/target/release';
const fixture = async fn => { const root = await mkdtemp(join(tmpdir(), 'cf-private-cache-')); try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); } };
const desktopManifest = (version = '0.2.1') => `[package]\nname = "codeferry-desktop"\nversion = "${version}"\nedition = "2021"\n[features]\ndefault = ["dependency/one"]\n[dependencies]\ndependency = { version = "=1.2.3", features = ["one"] }\n`;
const desktopLock = (version = '0.2.1') => `# Cargo-generated fixture\nversion = 4\n\n[[package]]\nname = "codeferry-desktop"\nversion = "${version}"\ndependencies = [\n "dependency",\n]\n\n[[package]]\nname = "dependency"\nversion = "1.2.3"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${'c'.repeat(64)}"\n`;
async function inputs(root) {
  for (const name of ['upstream/baseline.json', 'upstream/remotemcp.patch', 'upstream/webcodex/Cargo.lock', 'upstream/webcodex/Cargo.toml',
    'gateway-rs/Cargo.lock', 'gateway-rs/Cargo.toml', 'desktop-tauri/src-tauri/Cargo.lock', 'desktop-tauri/src-tauri/Cargo.toml']) {
    await mkdir(dirname(join(root, name)), { recursive: true }); await writeFile(join(root, name), name);
  }
  await writeFile(join(root, 'desktop-tauri/src-tauri/Cargo.toml'), desktopManifest());
  await writeFile(join(root, 'desktop-tauri/src-tauri/Cargo.lock'), desktopLock());
}
async function buildTarget(root) {
  await inputs(root);
  for (const name of [target + '/deps/libfixture.rlib', target + '/build/pkg/out/output.bin', target + '/.fingerprint/pkg/lib-pkg',
    target + '/bundle/appimage/CodeFerry.AppImage', target + '/bundle/macos/CodeFerry.app.tar.gz.sig',
    target + '/deps/test.exe', target + '/incremental/heavy.bin', target + '/private/signing.key', target + '/deps/debug.dSYM/file']) {
    await mkdir(dirname(join(root, name)), { recursive: true }); await writeFile(join(root, name), 'private fixture ' + name);
  }
}
function fakeTransport() {
  const rows = new Map(), calls = [];
  return { rows, calls, privateRepository: async () => true,
    async read(tag) { calls.push(['read', tag]); return rows.get(tag)?.release ?? null; },
    async create(tag, sha) { calls.push(['create', tag, sha]); if (rows.has(tag)) throw Error('already exists'); rows.set(tag, { release: { tag_name: tag, draft: true, assets: [] } }); },
    async upload(tag, directory) { calls.push(['upload', tag]); const row = rows.get(tag); row.files = new Map();
      for (const name of ['cargo-cache.tar.gz', 'cache.json']) { const data = await readFile(join(directory, name)); row.files.set(name, data); row.release.assets.push({ name, size: data.length }); } },
    async download(tag, directory) { calls.push(['download', tag]); for (const [name, data] of rows.get(tag).files) await writeFile(join(directory, name), data); },
  };
}
test('cache keys bind exact locks native patch toolchain OS architecture role image, reuse changed application source', async () => fixture(async root => {
  await inputs(root); const identity = { source: root, bucket, platform: 'linux', arch: 'x64', rustc: 'rustc 1.96.0\nhost: x86_64-unknown-linux-gnu', imageOS: 'ubuntu24', imageVersion: '20261001' };
  const first = await cacheKey(identity); await writeFile(join(root, 'gateway-rs/src.rs'), 'changed code'); assert.equal(await cacheKey(identity), first);
  for (const patch of [{ imageVersion: '20261002' }, { bucket: 'validate-linux-x64' }]) assert.notEqual(await cacheKey({ ...identity, ...patch }), first);
  await writeFile(join(root, 'gateway-rs/Cargo.lock'), 'changed lock'); assert.notEqual(await cacheKey(identity), first);
  await assert.rejects(cacheKey({ ...identity, rustc: 'rustc 1.95.0' }), /IDENTITY_INVALID/);
  await assert.rejects(cacheKey({ ...identity, arch: 'arm64' }), /IDENTITY_INVALID/);
  assert.deepEqual(partsFor('desktop-darwin-arm64'), ['native-release', 'desktop-debug', 'desktop-release']);
  assert.throws(() => partsFor('../escape'), /BUCKET_INVALID/);
}));
test('manifest release assets and archive sizes are bounded and exact', () => {
  const row = { schema: 1, key, bucket, part, generation: 'partial', targets: [target], size: 12, sha256: 'c'.repeat(64), entries: 3, expanded: 14 };
  validateManifest(row, { key, bucket, part });
  for (const edit of [{ size: MAX_ARCHIVE + 1 }, { expanded: MAX_EXPANDED + 1 }, { entries: 100001 }, { targets: [target, 'private'] }, { key: 'd'.repeat(64) }, { signingKey: 'secret' }])
    assert.throws(() => validateManifest({ ...row, ...edit }, { key, bucket, part }), /MANIFEST_INVALID/);
  const release = { tag_name: tagFor(bucket, key, part), draft: true, assets: [{ name: 'cargo-cache.tar.gz', size: 12 }, { name: 'cache.json', size: 99 }] };
  validateRelease(release, release.tag_name);
  for (const edit of [{ draft: false }, { assets: [...release.assets, { name: 'signing.key', size: 1 }] }, { assets: [{ name: 'cargo-cache.tar.gz', size: MAX_ARCHIVE + 1 }, release.assets[1]] }])
    assert.throws(() => validateRelease({ ...release, ...edit }, release.tag_name), /RELEASE_INVALID/);
});
test('private immutable compiled cache roundtrip excludes bundles tests incremental and signing outputs', async () => fixture(async root => {
  const source = join(root, 'source'), temporary = join(root, 'temporary'); await mkdir(source); await mkdir(temporary); await buildTarget(source);
  const transport = fakeTransport(); assert.equal(await savePart({ source, temporary, bucket, key, part, sourceSha, transport }), true);
  assert.equal(transport.calls.filter(x => x[0] === 'create').length, 1);
  assert.equal(await savePart({ source, temporary, bucket, key, part, sourceSha, transport }), false);
  assert.equal(transport.calls.filter(x => x[0] === 'upload').length, 1);
  await rm(join(source, 'gateway-rs/target'), { recursive: true });
  await writeFile(join(source, 'gateway-rs/src.rs'), 'new private application source');
  assert.equal(await restorePart({ source, temporary, bucket, key, part, transport }), 'partial');
  assert.equal(await readFile(join(source, target + '/deps/libfixture.rlib'), 'utf8'), 'private fixture ' + target + '/deps/libfixture.rlib');
  assert.deepEqual((await readdir(join(source, target))).sort(), ['.fingerprint', 'build', 'deps']);
  assert.deepEqual(await readdir(join(source, target + '/deps')), ['libfixture.rlib']);
  await assert.rejects(restorePart({ source, temporary, bucket, key, part, transport }), /TARGET_EXISTS/);
}));
test('altered archive rejected before touching selected target, existing cache never overwritten', async () => fixture(async root => {
  const source = join(root, 'source'), temporary = join(root, 'temporary'); await mkdir(source); await mkdir(temporary); await buildTarget(source);
  const transport = fakeTransport(); await savePart({ source, temporary, bucket, key, part, sourceSha, transport });
  await rm(join(source, 'gateway-rs/target'), { recursive: true });
  transport.rows.get(tagFor(bucket, key, part)).files.set('cargo-cache.tar.gz', Buffer.from('tampered'));
  assert.equal(await restorePart({ source, temporary, bucket, key, part, transport }), false);
  await assert.rejects(readdir(join(source, target)), { code: 'ENOENT' });
}));
test('partial cache can promote to one separate immutable complete generation which restores first', async () => fixture(async root => {
  const source = join(root, 'source'), temporary = join(root, 'temporary'); await mkdir(source); await mkdir(temporary); await buildTarget(source);
  const transport = fakeTransport();
  await savePart({ source, temporary, bucket, key, part, sourceSha, transport, complete: false });
  const partialTag = tagFor(bucket, key, part, 'partial'), completeTag = tagFor(bucket, key, part, 'complete');
  const partialBytes = Buffer.from(transport.rows.get(partialTag).files.get('cargo-cache.tar.gz'));
  await writeFile(join(source, target + '/deps/libadditional.rlib'), 'dependency from later successful compilation');
  assert.equal(await savePart({ source, temporary, bucket, key, part, sourceSha, transport, complete: false }), false);
  assert.equal(await savePart({ source, temporary, bucket, key, part, sourceSha, transport, complete: true }), true);
  assert.equal(await savePart({ source, temporary, bucket, key, part, sourceSha, transport, complete: true }), false);
  assert.equal(transport.rows.size, 2); assert.deepEqual(transport.rows.get(partialTag).files.get('cargo-cache.tar.gz'), partialBytes);
  await rm(join(source, 'gateway-rs/target'), { recursive: true }); transport.calls.length = 0;
  assert.equal(await restorePart({ source, temporary, bucket, key, part, transport }), 'complete');
  assert.equal(await readFile(join(source, target + '/deps/libadditional.rlib'), 'utf8'), 'dependency from later successful compilation');
  assert.equal(transport.calls.some(c => c[0] === 'download' && c[1] === partialTag), false);
  assert(transport.calls.some(c => c[0] === 'download' && c[1] === completeTag));
}));
test('a restored partial state is promoted by a successful full job rather than skipped', async () => fixture(async root => {
  const source = join(root, 'source'), temporary = join(root, 'temporary'); await mkdir(source); await mkdir(temporary); await inputs(source);
  const desktopBucket = `desktop-${process.platform}-${process.arch}`, desktopPart = 'desktop-debug';
  const desktopTarget = 'desktop-tauri/src-tauri/target/debug';
  await mkdir(join(source, desktopTarget + '/deps'), { recursive: true });
  await writeFile(join(source, desktopTarget + '/deps/libfirst.rlib'), 'compiled first dependency');
  const rustc = 'rustc 1.96.0\nhost: fixture', exactKey = await cacheKey({ source, bucket: desktopBucket, part: desktopPart, rustc });
  const transport = fakeTransport();
  await savePart({ source, temporary, bucket: desktopBucket, key: exactKey, part: desktopPart, sourceSha, transport, complete: false });
  await rm(join(source, desktopTarget), { recursive: true });
  const state = await runCache('restore', desktopBucket, { source, temporary, sourceSha, transport, rustc });
  assert.equal(state.hit[desktopPart], 'partial');
  await writeFile(join(source, desktopTarget + '/deps/libsecond.rlib'), 'compiled second dependency');
  await runCache('save', desktopBucket, { source, temporary, sourceSha, transport, rustc, complete: 'true' });
  assert(transport.rows.has(tagFor(desktopBucket, exactKey, desktopPart, 'complete')));
  assert(transport.rows.has(tagFor(desktopBucket, exactKey, desktopPart, 'partial')));
  await assert.rejects(runCache('save', desktopBucket, { source, temporary, sourceSha, transport, rustc, complete: 'yes' }), /GENERATION_INVALID/);
}));
test('native cache key survives desktop version bumps and CI debug flags are bound exactly', async () => fixture(async root => {
  await inputs(root);
  const identity = { source: root, bucket: 'desktop-darwin-arm64', platform: 'darwin', arch: 'arm64', rustc: 'rustc 1.96.0\nhost: aarch64-apple-darwin' };
  const native = await cacheKey({ ...identity, part: 'native-release' });
  const desktop = await cacheKey({ ...identity, part: 'desktop-debug' });
  const gateway = await cacheKey({ ...identity, bucket, platform: 'linux', arch: 'x64', part: 'gateway-release' });
  await writeFile(join(root, 'desktop-tauri/src-tauri/Cargo.lock'), 'desktop version bump only');
  assert.equal(await cacheKey({ ...identity, part: 'native-release' }), native);
  assert.equal(await cacheKey({ ...identity, bucket, platform: 'linux', arch: 'x64', part: 'gateway-release' }), gateway);
  await assert.rejects(cacheKey({ ...identity, part: 'desktop-debug' }), /VERSION_AMBIGUOUS/);
  assert.notEqual(await cacheKey({ ...identity, part: 'native-release', compileFlags: { CARGO_PROFILE_DEV_DEBUG: '0', CARGO_PROFILE_TEST_DEBUG: '0', CARGO_INCREMENTAL: '0' } }), native);
}));
test('desktop delivery version alone reuses dependency keys while every dependency input stays exact', async () => fixture(async root => {
  await inputs(root);
  const identity = { source: root, bucket: 'desktop-darwin-arm64', platform: 'darwin', arch: 'arm64', part: 'desktop-debug', rustc: 'rustc 1.96.0\nhost: aarch64-apple-darwin' };
  const before = await cacheKey(identity);
  await writeFile(join(root, 'desktop-tauri/src-tauri/Cargo.toml'), desktopManifest('0.2.2'));
  await writeFile(join(root, 'desktop-tauri/src-tauri/Cargo.lock'), desktopLock('0.2.2'));
  assert.equal(await cacheKey(identity), before);
  const normalized = normalizeDesktopInputs(Buffer.from(desktopManifest()), Buffer.from(desktopLock()));
  assert.equal(normalized.manifest.toString(), desktopManifest().replace('version = "0.2.1"', 'version = "__CODEFERRY_APPLICATION_VERSION__"'));
  assert.equal(normalized.lock.toString(), desktopLock().replace('version = "0.2.1"', 'version = "__CODEFERRY_APPLICATION_VERSION__"'));
  for (const manifest of [desktopManifest('0.2.2').replace('=1.2.3', '=1.2.4'), desktopManifest('0.2.2').replace('dependency/one', 'dependency/two'), desktopManifest('0.2.2').replace('features = ["one"]', 'features = ["two"]')]) {
    await writeFile(join(root, 'desktop-tauri/src-tauri/Cargo.toml'), manifest); assert.notEqual(await cacheKey(identity), before);
  }
  await writeFile(join(root, 'desktop-tauri/src-tauri/Cargo.toml'), desktopManifest('0.2.2'));
  for (const lock of [desktopLock('0.2.2').replace('version = "1.2.3"', 'version = "1.2.4"'), desktopLock('0.2.2').replace('registry+', 'git+'), desktopLock('0.2.2').replace('c'.repeat(64), 'd'.repeat(64))]) {
    await writeFile(join(root, 'desktop-tauri/src-tauri/Cargo.lock'), lock); assert.notEqual(await cacheKey(identity), before);
  }
}));
test('desktop version normalization rejects ambiguous remote or unmatched application records', () => {
  for (const [manifest, lock] of [
    [desktopManifest(), desktopLock('0.2.2')],
    [desktopManifest(), desktopLock().replace('dependencies = [', 'source = "registry+https://example.test"\ndependencies = [')],
    [desktopManifest(), desktopLock().replace('dependencies = [', 'checksum = "' + 'a'.repeat(64) + '"\ndependencies = [')],
    [desktopManifest(), desktopLock() + '\n[[package]]\nname = "codeferry-desktop"\nversion = "0.2.1"\n'],
    [desktopManifest().replace('version = "0.2.1"', 'version = "0.2.1"\nversion = "0.2.1"'), desktopLock()],
    [desktopManifest().replace('name = "codeferry-desktop"', '"name" = "codeferry-desktop"'), desktopLock()],
    [desktopManifest(), desktopLock().replace('name = "codeferry-desktop"', '"name" = "codeferry-desktop"')],
    [desktopManifest().replace('[package]', '["package"]'), desktopLock()],
    [desktopManifest().replace('edition = "2021"', 'description = """ambiguous\nversion = "0.2.1"\n"""'), desktopLock()],
    [desktopManifest(), desktopLock().replace('dependencies = [', 'replace = "codeferry-desktop 0.2.1"\ndependencies = [')],
  ]) assert.throws(() => normalizeDesktopInputs(Buffer.from(manifest), Buffer.from(lock)), /VERSION_AMBIGUOUS/);
});
test('symlink targets escape paths and special entries are never cached/restored', async () => fixture(async root => {
  const source = join(root, 'source'), temporary = join(root, 'temporary'); await mkdir(source); await mkdir(temporary); await buildTarget(source);
  await symlink(root, join(source, target + '/deps/escape'));
  await assert.rejects(savePart({ source, temporary, bucket, key, part, sourceSha, transport: fakeTransport() }), /COMMAND_FAILED/);
  const file = join(root, 'bad.tar.gz'), stage = join(root, 'stage'); await mkdir(stage);
  const py = process.platform === 'win32' ? 'python' : 'python3';
  for (const name of ['../escape', '/absolute', target + '/deps/signing.key', target + '/bundle/test.sig']) {
    execFileSync(py, ['-c', "import tarfile,io,sys;f=tarfile.open(sys.argv[1],'w:gz');i=tarfile.TarInfo(sys.argv[2]);i.size=1;i.mtime=1;f.addfile(i,io.BytesIO(b'x'));f.close()", file, name]);
    await assert.rejects(archive('restore', { file, stage, target }), /COMMAND_FAILED/); assert.deepEqual(await readdir(stage), []);
  }
}));
test('cache miss and uncertain private publication fail open without side-effect retries', async () => fixture(async root => {
  const source = join(root, 'source'), temporary = join(root, 'temporary'); await mkdir(source); await mkdir(temporary); await buildTarget(source);
  const transport = fakeTransport(); let creates = 0; transport.create = async () => { creates++; throw Error('response lost'); };
  await assert.rejects(savePart({ source, temporary, bucket, key, part, sourceSha, transport }), /response lost/); assert.equal(creates, 1);
  const wrongRepo = { privateRepository: async () => false }; await assert.rejects(runCache('restore', bucket, { source, temporary, transport: wrongRepo }), /REPOSITORY_MUST_BE_PRIVATE/);
  assert.equal(await restorePart({ source, temporary, bucket, key, part, transport: fakeTransport() }), false);
}));
test('two independent Cargo builds reuse a cached compiled dependency as Fresh', async () => fixture(async root => {
  const shared = join(root, 'shared-dependency'); await mkdir(join(shared, 'src'), { recursive: true });
  await writeFile(join(shared, 'Cargo.toml'), '[package]\nname="cache_dependency"\nversion="0.1.0"\nedition="2021"\n');
  await writeFile(join(shared, 'src/lib.rs'), 'pub fn value() -> u32 { 42 }\n');
  const first = join(root, 'first'), second = join(root, 'second'), temporary = join(root, 'temporary');
  await mkdir(first); await mkdir(second); await mkdir(temporary); await inputs(first); await inputs(second);
  for (const source of [first, second]) {
    await mkdir(join(source, 'gateway-rs/src'), { recursive: true });
    await writeFile(join(source, 'gateway-rs/Cargo.toml'), '[package]\nname="cache_application"\nversion="0.1.0"\nedition="2021"\n[dependencies]\ncache_dependency={path=' + JSON.stringify(shared) + '}\n');
    await rm(join(source, 'gateway-rs/Cargo.lock')); // Cargo generates a real path-only lock without network access.
    await writeFile(join(source, 'gateway-rs/src/main.rs'), 'fn main() { println!("{}",cache_dependency::value()); }\n');
  }
  const build = source => execFileSync('cargo', ['check', '--offline', '--manifest-path', join(source, 'gateway-rs/Cargo.toml'), '-v'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  build(first);
  const transport = fakeTransport(), debugPart = 'gateway-debug', debugBucket = 'validate-linux-x64';
  await savePart({ source: first, temporary, bucket: debugBucket, key, part: debugPart, sourceSha, transport });
  await restorePart({ source: second, temporary, bucket: debugBucket, key, part: debugPart, transport });
  await cp(join(first, 'gateway-rs/Cargo.lock'), join(second, 'gateway-rs/Cargo.lock'));
  // stdout is empty for Cargo check; capture bounded stderr without printing source/debug paths.
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync('cargo', ['check', '--locked', '--offline', '--manifest-path', join(second, 'gateway-rs/Cargo.toml'), '-v'],
    { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 ** 2 });
  assert.equal(result.status, 0); assert.match(result.stderr, /Fresh cache_dependency v0\.1\.0/);
}));
test('real Cargo version bump reuses cached dependency and recompiles the application', async () => fixture(async root => {
  const shared = join(root, 'shared-dependency'); await mkdir(join(shared, 'src'), { recursive: true });
  await writeFile(join(shared, 'Cargo.toml'), '[package]\nname="cache_dependency"\nversion="0.1.0"\nedition="2021"\n');
  await writeFile(join(shared, 'src/lib.rs'), 'pub fn value() -> u32 { 42 }\n');
  const first = join(root, 'first'), second = join(root, 'second'), temporary = join(root, 'temporary');
  await mkdir(first); await mkdir(second); await mkdir(temporary); await inputs(first); await inputs(second);
  for (const [source, version] of [[first, '0.2.1'], [second, '0.2.2']]) {
    const manifest = join(source, 'desktop-tauri/src-tauri/Cargo.toml');
    await mkdir(join(dirname(manifest), 'src'), { recursive: true });
    await writeFile(manifest, '[package]\nname="codeferry-desktop"\nversion="' + version + '"\nedition="2021"\n[dependencies]\ncache_dependency={path=' + JSON.stringify(shared) + '}\n');
    await rm(join(dirname(manifest), 'Cargo.lock'));
    await writeFile(join(dirname(manifest), 'src/main.rs'), 'fn main() { println!("{}",cache_dependency::value()); }\n');
    execFileSync('cargo', ['generate-lockfile', '--offline', '--manifest-path', manifest], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  }
  const desktopBucket = `desktop-${process.platform}-${process.arch}`, desktopPart = 'desktop-debug';
  const identity = { bucket: desktopBucket, part: desktopPart, rustc: 'rustc 1.96.0\nhost: fixture' };
  const firstKey = await cacheKey({ ...identity, source: first }); assert.equal(await cacheKey({ ...identity, source: second }), firstKey);
  execFileSync('cargo', ['check', '--locked', '--offline', '--manifest-path', join(first, 'desktop-tauri/src-tauri/Cargo.toml'), '-v'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  const transport = fakeTransport(); await savePart({ source: first, temporary, bucket: desktopBucket, key: firstKey, part: desktopPart, sourceSha, transport });
  assert.equal(await restorePart({ source: second, temporary, bucket: desktopBucket, key: firstKey, part: desktopPart, transport }), 'partial');
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync('cargo', ['check', '--locked', '--offline', '--manifest-path', join(second, 'desktop-tauri/src-tauri/Cargo.toml'), '-v'], { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 ** 2 });
  assert.equal(result.status, 0); assert.match(result.stderr, /Fresh cache_dependency v0\.1\.0/);
  assert.match(result.stderr, /Checking codeferry-desktop v0\.2\.2/); assert.match(result.stderr, /Running .*--crate-name codeferry_desktop/);
}));
test('raw PAX metadata expanded tar and compressed file bounds reject before extraction', async () => fixture(async root => {
  const file = join(root, 'bounded.tar.gz'), stage = join(root, 'stage'); await mkdir(stage);
  const py = process.platform === 'win32' ? 'python' : 'python3';
  for (const [type, size] of [['x', 65537], ['0', MAX_EXPANDED + 1], ['S', 5]]) {
    execFileSync(py, ['-c', "import gzip,tarfile,sys;i=tarfile.TarInfo(sys.argv[2]);i.type=sys.argv[3].encode();i.size=int(sys.argv[4]);i.mtime=1;gzip.open(sys.argv[1],'wb').write(i.tobuf())", file, target, type, String(size)]);
    await assert.rejects(archive('restore', { file, stage, target }), /COMMAND_FAILED/);
    assert.deepEqual(await readdir(stage), []);
  }
  execFileSync(py, ['-c', "import gzip,tarfile,sys;i=tarfile.TarInfo(sys.argv[2]);i.size=5;i.mtime=1;i.pax_headers={'GNU.sparse.map':'0,0','GNU.sparse.size':'5'};gzip.open(sys.argv[1],'wb').write(i.tobuf(format=tarfile.PAX_FORMAT)+b'\\0'*512)", file, target + '/deps/sparse.rlib']);
  await assert.rejects(archive('restore', { file, stage, target }), /COMMAND_FAILED/);
  assert.deepEqual(await readdir(stage), []);
}));
test('raw local and global PAX sparse records reject before tarfile opens the archive', async () => fixture(async root => {
  const file = join(root, 'sparse.tar.gz'), stage = join(root, 'stage'); await mkdir(stage);
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const script = String.raw`import gzip,tarfile,sys,importlib.util,pathlib
spec=importlib.util.spec_from_file_location('cache_helper',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
for kind in [b'x',b'g']:
 for key in ['GNU.sparse.map','GNU.sparse.major','GNU.sparse.realsize','GNU.sparse.name']:
  value=key+'=0\n';length=len(value)+2
  while length != len(str(length))+1+len(value):length=len(str(length))+1+len(value)
  payload=(str(length)+' '+value).encode();header=tarfile.TarInfo('pax');header.type=kind;header.size=len(payload)
  with gzip.open(sys.argv[2],'wb') as f:f.write(header.tobuf());f.write(payload);f.write(b'\0'*((-len(payload))%512));f.write(b'\0'*1024)
  original=m.tarfile.open;m.tarfile.open=lambda *a,**k: (_ for _ in ()).throw(AssertionError('tarfile parse reached'))
  try:
   try:m.restore(pathlib.Path(sys.argv[2]),pathlib.Path(sys.argv[3]),[sys.argv[4]])
   except m.CacheError:pass
   else:raise AssertionError('sparse accepted')
  finally:m.tarfile.open=original
print('RAW_PAX_SPARSE_REJECTED')`;
  const helper = new URL('../private-cache-archive.py', import.meta.url).pathname;
  assert.equal(execFileSync(py, ['-c', script, helper, file, stage, target], { encoding: 'utf8', timeout: 10_000 }).trim(), 'RAW_PAX_SPARSE_REJECTED');
  assert.deepEqual(await readdir(stage), []);
}));
test('workflow restores before Cargo, caches failed build dependencies, never publicly caches Rust targets', async () => {
  const text = await readFile(new URL('../../workflows/desktop-clients.yml', import.meta.url), 'utf8');
  assert.equal((text.match(/cache: npm/g) ?? []).length, 4);
  assert.equal((text.match(/private-cache\.mjs restore/g) ?? []).length, 3);
  assert.equal((text.match(/private-cache\.mjs save/g) ?? []).length, 3);
  assert.equal((text.match(/continue-on-error: true/g) ?? []).length, 6);
  assert.doesNotMatch(text, /actions\/cache|Swatin\/rust-cache|target\//);
  assert(text.indexOf('restore validate-linux-x64') < text.indexOf('native-format cargo fmt'));
  assert(text.indexOf('save validate-linux-x64') > text.indexOf('gateway-worker python3'));
  assert(text.indexOf('restore desktop-${{ matrix.platform }}') < text.indexOf('native-runtime node scripts/native-build.mjs'));
  assert(text.indexOf('save desktop-${{ matrix.platform }}') > text.indexOf('publish-private-asset.sh'));
  assert.equal((text.match(/if: \$\{\{ always\(\) && !cancelled\(\) \}\}/g) ?? []).length, 3);
  assert.equal((text.match(/CODEFERRY_DIAGNOSTIC_ROLE:/g) ?? []).length, 3);
  assert.equal((text.match(/if: failure\(\)/g) ?? []).length, 3);
  assert.equal((text.match(/CODEFERRY_CACHE_COMPLETE: \$\{\{ job.status == 'success' \}\}/g) ?? []).length, 3);
  for (const flag of ['CARGO_PROFILE_DEV_DEBUG', 'CARGO_PROFILE_TEST_DEBUG', 'CARGO_INCREMENTAL']) assert.match(text, new RegExp(`${flag}: '0'`));
});
