/** Cargo targets contain private code/debug paths; cache only in private source releases. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'crazylin/codeferry';
const SCHEMA = 1;
export const MAX_ARCHIVE = 1792 * 1024 ** 2;
export const MAX_EXPANDED = 12 * 1024 ** 3;
const NATIVE_INPUTS = ['upstream/baseline.json', 'upstream/remotemcp.patch',
  'upstream/webcodex/Cargo.lock', 'upstream/webcodex/Cargo.toml'];
const PARTS = {
  'native-debug': 'upstream/webcodex/target/debug', 'native-release': 'upstream/webcodex/target/release',
  'gateway-debug': 'gateway-rs/target/debug', 'gateway-release': 'gateway-rs/target/release',
  'desktop-debug': 'desktop-tauri/src-tauri/target/debug', 'desktop-release': 'desktop-tauri/src-tauri/target/release',
};
const helper = join(dirname(fileURLToPath(import.meta.url)), 'private-cache-archive.py');
const fail = code => { throw Error(code); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function partsFor(bucket) {
  if (bucket === 'validate-linux-x64') return ['native-debug', 'gateway-debug'];
  if (bucket === 'gateway-linux-x64') return ['gateway-release'];
  if (/^desktop-(?:darwin-arm64|linux-x64|win32-x64)$/.test(bucket)) return ['native-release', 'desktop-debug', 'desktop-release'];
  fail('PRIVATE_CACHE_BUCKET_INVALID');
}

export async function command(file, args, { cwd, env = process.env, timeout = 60_000, maxOutput = 1024 ** 2 } = {}) {
  const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let length = 0; const output = []; let stopped = false;
  const timer = setTimeout(() => { stopped = true; child.kill(); }, timeout);
  child.stdout.on('data', bytes => { length += bytes.length; if (length > maxOutput) { stopped = true; child.kill(); } else output.push(bytes); });
  // Never expose gh/private paths, source diagnostics or environment values.
  child.stderr.resume();
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    if (stopped || code !== 0) fail('PRIVATE_CACHE_COMMAND_FAILED');
    return Buffer.concat(output).toString('utf8');
  } finally { clearTimeout(timer); }
}

async function regular(path, maximum = 2 * 1024 ** 2) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximum) fail('PRIVATE_CACHE_INPUT_INVALID');
  return readFile(path);
}
async function safeParents(root, relative, create = false) {
  let path = root;
  for (const part of relative.split('/').slice(0, -1)) {
    path = join(path, part);
    if (create) { try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('PRIVATE_CACHE_PATH_INVALID');
  }
}
/** Normalize only the local application's delivery version, never dependency input.
 * Cargo fingerprints still rebuild this package after a version change. A format
 * outside this narrow Cargo-generated convention is a safe cache miss.
 */
export function normalizeDesktopInputs(manifestBytes, lockBytes) {
  const invalid = () => fail('PRIVATE_CACHE_DESKTOP_VERSION_AMBIGUOUS');
  const decode = bytes => {
    let value; try { value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { invalid(); }
    if (value.includes('"""') || value.includes("'''")) invalid();
    return value;
  };
  const rows = value => Array.from(value.matchAll(/[^\n]+(?:\n|$)|\n/g), row => ({
    text: row[0].replace(/\r?\n$/, ''), offset: row.index,
  }));
  const blank = line => /^[ \t]*(?:#.*)?$/.test(line);
  const scalar = line => {
    const found = /^[ \t]*([a-zA-Z][a-zA-Z0-9_-]*)[ \t]*=[ \t]*("(?:[^"\\\r\n]|\\.)*")[ \t]*(?:#.*)?$/.exec(line);
    if (!found) invalid();
    let value; try { value = JSON.parse(found[2]); } catch { invalid(); }
    return { key: found[1], value, literal: found[2], index: line.indexOf(found[2]) };
  };
  const version = value => /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
  const manifest = decode(manifestBytes), lock = decode(lockBytes), manifestRows = rows(manifest), lockRows = rows(lock);
  const headers = manifestRows.filter(row => /^[ \t]*\[/.test(row.text));
  if (!headers.length || !/^[ \t]*\[package\][ \t]*(?:#.*)?$/.test(headers[0].text) ||
      headers.filter(row => /^[ \t]*\[package\][ \t]*(?:#.*)?$/.test(row.text)).length !== 1 ||
      headers.some(row => /^[ \t]*\[[ \t]*["']package["']/.test(row.text)) ||
      manifestRows.some(row => row.offset < headers[0].offset && !blank(row.text))) invalid();
  const packageRows = manifestRows.filter(row => row.offset > headers[0].offset && row.offset < (headers[1]?.offset ?? manifest.length));
  let manifestVersion; const manifestKeys = new Set(); let manifestName;
  for (const row of packageRows) {
    if (blank(row.text)) continue;
    // Other package metadata remains byte-for-byte bound. Noncanonical or
    // multiline assignments are not guessed at when producing reusable keys.
    const key = /^[ \t]*([a-zA-Z][a-zA-Z0-9_-]*)[ \t]*=/.exec(row.text)?.[1];
    if (!key || manifestKeys.has(key)) invalid(); manifestKeys.add(key);
    if (key === 'name' || key === 'version') {
      const value = scalar(row.text);
      if (key === 'name') manifestName = value.value;
      else manifestVersion = { ...value, offset: row.offset };
    } else if (row.text.trimEnd().endsWith('[') || row.text.trimEnd().endsWith('{')) invalid();
  }
  if (manifestName !== 'codeferry-desktop' || !manifestVersion || !version(manifestVersion.value)) invalid();
  const blocks = []; let current; let array = false; let lockHeader = false;
  for (const row of lockRows) {
    if (blank(row.text)) continue;
    if (/^[ \t]*\[\[package\]\][ \t]*(?:#.*)?$/.test(row.text)) {
      if (array || !lockHeader) invalid(); current = { keys: new Set() }; blocks.push(current); continue;
    }
    if (!current) {
      if (lockHeader || !/^[ \t]*version[ \t]*=[ \t]*[34][ \t]*(?:#.*)?$/.test(row.text)) invalid();
      lockHeader = true; continue;
    }
    if (array) {
      if (/^[ \t]*\][ \t]*(?:#.*)?$/.test(row.text)) { array = false; continue; }
      if (!/^[ \t]*"(?:[^"\\\r\n]|\\.)*",[ \t]*(?:#.*)?$/.test(row.text)) invalid();
      continue;
    }
    const dependency = /^[ \t]*dependencies[ \t]*=[ \t]*\[[ \t]*(\])?[ \t]*(?:#.*)?$/.exec(row.text);
    if (dependency) {
      if (current.keys.has('dependencies')) invalid(); current.keys.add('dependencies'); array = !dependency[1]; continue;
    }
    const value = scalar(row.text);
    if (!['name', 'version', 'source', 'checksum', 'replace'].includes(value.key) || current.keys.has(value.key)) invalid();
    current.keys.add(value.key); current[value.key] = { ...value, offset: row.offset };
  }
  if (array || blocks.some(block => !block.name || !block.version || !version(block.version.value))) invalid();
  const applications = blocks.filter(block => block.name.value === 'codeferry-desktop');
  if (applications.length !== 1 || applications[0].keys.has('source') || applications[0].keys.has('checksum') ||
      applications[0].keys.has('replace') || applications[0].version.value !== manifestVersion.value) invalid();
  const replace = (text, value) => {
    const start = value.offset + value.index;
    return text.slice(0, start) + '"__CODEFERRY_APPLICATION_VERSION__"' + text.slice(start + value.literal.length);
  };
  return { manifest: Buffer.from(replace(manifest, manifestVersion)), lock: Buffer.from(replace(lock, applications[0].version)) };
}
export async function cacheKey({ source, bucket, platform = process.platform, arch = process.arch,
  part = partsFor(bucket)[0], rustc, imageOS = process.env.ImageOS ?? '', imageVersion = process.env.ImageVersion ?? '',
  compileFlags = { CARGO_PROFILE_DEV_DEBUG: process.env.CARGO_PROFILE_DEV_DEBUG ?? '',
    CARGO_PROFILE_TEST_DEBUG: process.env.CARGO_PROFILE_TEST_DEBUG ?? '', CARGO_INCREMENTAL: process.env.CARGO_INCREMENTAL ?? '' } }) {
  if (!partsFor(bucket).includes(part)) fail('PRIVATE_CACHE_IDENTITY_INVALID');
  if (!['linux:x64', 'darwin:arm64', 'win32:x64'].includes(platform + ':' + arch) ||
      !bucket.endsWith(platform + '-' + arch) || !/^rustc 1\.96\.0\b/m.test(rustc ?? '') ||
      rustc.length > 4096 || imageOS.length > 128 || imageVersion.length > 128 ||
      Object.keys(compileFlags).sort().join(',') !== 'CARGO_INCREMENTAL,CARGO_PROFILE_DEV_DEBUG,CARGO_PROFILE_TEST_DEBUG' ||
      Object.values(compileFlags).some(value => typeof value !== 'string' || value.length > 16)) fail('PRIVATE_CACHE_IDENTITY_INVALID');
  const names = [...NATIVE_INPUTS];
  if (part.startsWith('gateway-')) names.push('gateway-rs/Cargo.lock', 'gateway-rs/Cargo.toml');
  if (part.startsWith('desktop-')) names.push('desktop-tauri/src-tauri/Cargo.lock', 'desktop-tauri/src-tauri/Cargo.toml');
  const values = new Map();
  for (const name of names) { await safeParents(source, name); values.set(name, await regular(join(source, name))); }
  if (part.startsWith('desktop-')) {
    const base = 'desktop-tauri/src-tauri/';
    const normalized = normalizeDesktopInputs(values.get(base + 'Cargo.toml'), values.get(base + 'Cargo.lock'));
    values.set(base + 'Cargo.toml', normalized.manifest); values.set(base + 'Cargo.lock', normalized.lock);
  }
  const inputs = Array.from(values, ([name, bytes]) => [name, hash(bytes)]);
  return hash(JSON.stringify({ schema: SCHEMA, bucket, part, platform, arch, rustc, imageOS, imageVersion, compileFlags, inputs }));
}
export function tagFor(bucket, key, part, generation = 'partial') {
  if (!partsFor(bucket).includes(part) || !/^[a-f0-9]{64}$/.test(key) || !['partial', 'complete'].includes(generation)) fail('PRIVATE_CACHE_IDENTITY_INVALID');
  return `cargo-cache-v${SCHEMA}-${bucket}-${part}-${generation}-${key}`;
}
export async function fileIdentity(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_ARCHIVE) fail('PRIVATE_CACHE_ARCHIVE_INVALID');
  const digest = createHash('sha256'); let size = 0;
  for await (const chunk of createReadStream(path)) { size += chunk.length; if (size > MAX_ARCHIVE) fail('PRIVATE_CACHE_ARCHIVE_INVALID'); digest.update(chunk); }
  if (size !== info.size) fail('PRIVATE_CACHE_ARCHIVE_CHANGED');
  return { size, sha256: digest.digest('hex') };
}

export function validateManifest(row, { key, bucket, part, generation = 'partial' }) {
  if (!row || row.schema !== SCHEMA || row.key !== key || row.bucket !== bucket || row.part !== part || row.generation !== generation ||
      row.targets?.length !== 1 || row.targets[0] !== PARTS[part] ||
      !Number.isSafeInteger(row.size) || row.size < 1 || row.size > MAX_ARCHIVE ||
      !/^[a-f0-9]{64}$/.test(row.sha256 ?? '') ||
      !Number.isSafeInteger(row.entries) || row.entries < 1 || row.entries > 100_000 ||
      !Number.isSafeInteger(row.expanded) || row.expanded < 1 || row.expanded > MAX_EXPANDED ||
      Object.keys(row).sort().join(',') !== 'bucket,entries,expanded,generation,key,part,schema,sha256,size,targets') fail('PRIVATE_CACHE_MANIFEST_INVALID');
}
export function validateRelease(release, tag) {
  if (!release || release.tag_name !== tag || release.draft !== true || !Array.isArray(release.assets) ||
      release.assets.length !== 2 || new Set(release.assets.map(a => a.name)).size !== 2) fail('PRIVATE_CACHE_RELEASE_INVALID');
  for (const asset of release.assets) {
    if (!['cargo-cache.tar.gz', 'cache.json'].includes(asset.name) ||
        !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > (asset.name === 'cache.json' ? 16 * 1024 : MAX_ARCHIVE)) fail('PRIVATE_CACHE_RELEASE_INVALID');
  }
}
export async function archive(mode, { source, file, stage, target }) {
  const env = { ...process.env };
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD', 'CODEFERRY_PUBLISH_KEY']) delete env[name];
  const args = [helper, mode, '--archive', file, '--targets', target];
  if (source) args.push('--source', source); if (stage) args.push('--stage', stage);
  return JSON.parse(await command(process.platform === 'win32' ? 'python' : 'python3', args, { env, timeout: 660_000, maxOutput: 16 * 1024 }));
}

export function githubTransport() {
  const gh = args => command('gh', args, { timeout: 60_000 });
  return {
    async privateRepository() { return (await gh(['api', `repos/${REPO}`, '--jq', '.private'])).trim() === 'true'; },
    async read(tag) {
      // Draft tags may return REST 404 while `gh release view` can resolve
      // authenticated private drafts. Normalize its bounded JSON fields.
      try {
        const row = JSON.parse(await gh(['release', 'view', tag, '--repo', REPO, '--json', 'assets,isDraft,tagName']));
        return { tag_name: row.tagName, draft: row.isDraft, assets: row.assets?.map(asset => ({ name: asset.name, size: asset.size })) };
      }
      catch { return null; }
    },
    async download(tag, directory) {
      await command('gh', ['release', 'download', tag, '--repo', REPO, '--pattern', 'cargo-cache.tar.gz',
        '--pattern', 'cache.json', '--dir', directory], { timeout: 600_000 });
    },
    async create(tag, sourceSha) {
      // Creation/upload are attempted once. A lost response remains a safe miss;
      // never overwrite or retry a possibly successful release side effect.
      await gh(['release', 'create', tag, '--repo', REPO, '--target', sourceSha,
        '--draft', '--title', 'CodeFerry private Rust cache', '--notes', '']);
    },
    async upload(tag, directory) {
      await command('gh', ['release', 'upload', tag, join(directory, 'cargo-cache.tar.gz'),
        join(directory, 'cache.json'), '--repo', REPO], { timeout: 600_000 });
    },
  };
}

async function restoreGeneration({ source, temporary, bucket, key, part, transport, generation }) {
  const tag = tagFor(bucket, key, part, generation); const release = await transport.read(tag);
  if (!release) return false;
  validateRelease(release, tag);
  const directory = await mkdtemp(join(temporary, 'private-cache-restore-'));
  try {
    await transport.download(tag, directory);
    if ((await readdir(directory)).sort().join(',') !== 'cache.json,cargo-cache.tar.gz') fail('PRIVATE_CACHE_DOWNLOAD_SET_INVALID');
    const row = JSON.parse((await regular(join(directory, 'cache.json'), 16 * 1024)).toString());
    validateManifest(row, { key, bucket, part, generation });
    const actual = await fileIdentity(join(directory, 'cargo-cache.tar.gz'));
    if (actual.size !== row.size || actual.sha256 !== row.sha256) fail('PRIVATE_CACHE_ARCHIVE_CHANGED');
    const target = PARTS[part]; await safeParents(source, target.split('/').slice(0, -1).join('/'));
    const output = join(source, target);
    // Independent fresh checkouts restore only before any Cargo invocation.
    try { await lstat(output); fail('PRIVATE_CACHE_TARGET_EXISTS'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const stage = join(directory, 'stage'); await mkdir(stage, { mode: 0o700 });
    const inspected = await archive('restore', { file: join(directory, 'cargo-cache.tar.gz'), stage, target });
    if (inspected.entries !== row.entries || inspected.expanded !== row.expanded || inspected.targets?.[0] !== target) fail('PRIVATE_CACHE_ARCHIVE_CHANGED');
    await safeParents(source, target, true);
    await rename(join(stage, target), output); // Validated tree moves atomically; no existing target is replaced.
    return generation;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function restorePart(options) {
  for (const generation of ['complete', 'partial']) {
    try { const restored = await restoreGeneration({ ...options, generation }); if (restored) return restored; }
    catch (error) {
      // A corrupt completed generation may still have a verified partial cache.
      // Target conflicts are never treated as permission to replace that tree.
      if (error.message === 'PRIVATE_CACHE_TARGET_EXISTS') throw error;
    }
  }
  return false;
}

export async function savePart({ source, temporary, bucket, key, part, sourceSha, transport, complete = false }) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? '')) fail('PRIVATE_CACHE_SOURCE_INVALID');
  if (typeof complete !== 'boolean') fail('PRIVATE_CACHE_GENERATION_INVALID');
  const generation = complete ? 'complete' : 'partial'; const tag = tagFor(bucket, key, part, generation);
  if (await transport.read(tag)) return false; // Immutable existing cache tags/assets are never overwritten.
  await safeParents(source, PARTS[part] + '/placeholder');
  const directory = await mkdtemp(join(temporary, 'private-cache-save-'));
  try {
    const file = join(directory, 'cargo-cache.tar.gz');
    const info = await archive('pack', { source, file, target: PARTS[part] });
    const row = { schema: SCHEMA, key, bucket, part, generation, ...info };
    validateManifest(row, { key, bucket, part, generation });
    await writeFile(join(directory, 'cache.json'), JSON.stringify(row), { flag: 'wx', mode: 0o600 });
    await transport.create(tag, sourceSha);
    await transport.upload(tag, directory);
    return true;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function runCache(mode, bucket, { source = resolve('source'), temporary = process.env.RUNNER_TEMP,
  sourceSha = process.env.SOURCE_SHA, transport = githubTransport(), rustc,
  complete = process.env.CODEFERRY_CACHE_COMPLETE ?? 'false' } = {}) {
  if (!['restore', 'save'].includes(mode) || !temporary) fail('PRIVATE_CACHE_ARGUMENT_INVALID');
  const parts = partsFor(bucket); const stateFile = join(temporary, `private-cache-state-${bucket}.json`);
  if (!await transport.privateRepository()) fail('PRIVATE_CACHE_REPOSITORY_MUST_BE_PRIVATE');
  rustc ??= await command('rustc', ['-Vv']);
  const keys = Object.fromEntries(await Promise.all(parts.map(async part => [part, await cacheKey({ source, bucket, part, rustc })])));
  if (!['true', 'false'].includes(complete)) fail('PRIVATE_CACHE_GENERATION_INVALID');
  let hit = {};
  if (mode === 'save') {
    const state = JSON.parse((await regular(stateFile, 16 * 1024)).toString());
    if (!state.keys || Object.keys(state.keys).length !== parts.length || parts.some(part => state.keys[part] !== keys[part]) ||
        state.bucket !== bucket || !state.hit || Array.isArray(state.hit) ||
        Object.entries(state.hit).some(([p, generation]) => !parts.includes(p) || !['partial', 'complete'].includes(generation))) fail('PRIVATE_CACHE_STATE_CHANGED');
    hit = state.hit;
  }
  for (const part of parts) {
    const key = keys[part];
    if (mode === 'save' && (hit[part] === 'complete' || hit[part] === 'partial' && complete === 'false')) continue;
    try {
      const changed = mode === 'restore' ? await restorePart({ source, temporary, bucket, key, part, transport }) :
        await savePart({ source, temporary, bucket, key, part, sourceSha, transport, complete: complete === 'true' });
      if (mode === 'restore' && changed) hit[part] = changed;
      console.log(`PRIVATE_RUST_CACHE_${mode === 'restore' ? changed ? 'HIT' : 'MISS' : changed ? 'SAVED' : 'UNCHANGED'}_${part.toUpperCase().replaceAll('-', '_')}`);
    } catch { console.log('PRIVATE_RUST_CACHE_SKIPPED_' + part.toUpperCase().replaceAll('-', '_')); }
  }
  if (mode === 'restore') await writeFile(stateFile, JSON.stringify({ keys, bucket, hit }), { flag: 'wx', mode: 0o600 });
  return { keys, bucket, hit };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, bucket] = process.argv.slice(2);
  try { await runCache(mode, bucket); }
  catch { console.log('PRIVATE_RUST_CACHE_UNAVAILABLE_BUILD_CONTINUES'); }
}
