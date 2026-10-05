// Prepare the host Runner for desktop packaging.
// matchingRuntime() accepts runtime/<platform>-<arch>/BUILD_INFO.json.
// electron-packager then copies that directory under its basename, while the
// client and the packager's own hash check read resources/runtime. After the
// platform check, an identical directory named runtime is what gets packaged.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { createReadStream } from 'node:fs';
import { access, chmod, copyFile, cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';

const MAX_FILE_BYTES = 512 * 1024 * 1024;
const TARGETS = {
  'darwin:arm64': 'aarch64-apple-darwin',
  'darwin:x64': 'x86_64-apple-darwin',
  'linux:x64': 'x86_64-unknown-linux-gnu',
  'linux:arm64': 'aarch64-unknown-linux-gnu',
  'win32:x64': 'x86_64-pc-windows-msvc',
  'win32:arm64': 'aarch64-pc-windows-msvc',
};
const BUILT_BINARIES = ['webcodex-server', 'webcodex', 'webcodex-runner'];
const PACKAGED_BINARIES = ['webcodex', 'webcodex-runner'];

function arg(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`MISSING_ARGUMENT:${name}`);
  return value;
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 15_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitStatusCode(cwd, args) {
  try {
    git(cwd, args);
    return 0;
  } catch (error) {
    if (typeof error.status === 'number') return error.status;
    throw error;
  }
}

async function fileDigest(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error('NATIVE_BUILD_UNSAFE_INPUT');
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    if (bytes > MAX_FILE_BYTES) throw new Error('NATIVE_BUILD_INPUT_TOO_LARGE');
    digest.update(chunk);
  }
  if (bytes !== stat.size) throw new Error('NATIVE_BUILD_INPUT_CHANGED');
  return digest.digest('hex');
}

async function nativeSourceIdentity(upstream, baseline) {
  if (git(upstream, ['rev-parse', `${baseline.ref}^{commit}`]).trim() !== baseline.commit) {
    throw new Error('NATIVE_BUILD_BASELINE_REF_MISMATCH');
  }
  if (gitStatusCode(upstream, ['merge-base', '--is-ancestor', baseline.commit, 'HEAD']) !== 0) {
    throw new Error('NATIVE_BUILD_BASELINE_NOT_ANCESTOR');
  }
  const revision = git(upstream, ['rev-parse', 'HEAD']).trim();
  if (!/^[a-f0-9]{40}$/u.test(revision)) throw new Error('NATIVE_BUILD_INVALID_REVISION');
  const status = git(upstream, ['status', '--porcelain', '--untracked-files=all']);
  const untracked = git(upstream, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).sort();
  if (untracked.length > 256) throw new Error('NATIVE_BUILD_TOO_MANY_INPUTS');
  let patched = untracked.length > 0;
  const diffStatus = gitStatusCode(upstream, ['diff', '--quiet', baseline.commit, '--']);
  if (diffStatus === 1) patched = true;
  else if (diffStatus !== 0) throw new Error('NATIVE_BUILD_DIFF_FAILED');
  const digest = createHash('sha256').update(revision).update('\0').update(status).update('\0')
    .update(git(upstream, ['diff', '--binary', 'HEAD', '--']));
  const root = resolve(upstream);
  for (const name of untracked) {
    const path = resolve(upstream, name);
    if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error('NATIVE_BUILD_UNSAFE_INPUT');
    digest.update('\0').update(name).update('\0').update(await fileDigest(path));
  }
  return { revision, dirty: Boolean(status.trim()), patched, inputsSha256: digest.digest('hex') };
}

function validateBinary(info, binary, baseline, source, architecture, expectedTarget) {
  const nativeArchitecture = { arm64: 'aarch64', x64: 'x86_64' }[architecture];
  if (!nativeArchitecture || info?.schema_version !== 1 || info.binary !== binary || info.version !== baseline.version ||
      info.git_commit !== source.revision || info.git_dirty !== source.dirty ||
      info.architecture !== nativeArchitecture || info.target !== expectedTarget ||
      !/^\d+$/u.test(info.built_at ?? '') || !(Number(info.built_at) > 0) ||
      (binary !== 'webcodex' && (!Number.isSafeInteger(info.agent_protocol_generation) || info.agent_protocol_generation < 1))) {
    throw new Error(`NATIVE_BUILD_BINARY_IDENTITY_MISMATCH:${binary}`);
  }
  return info;
}

function readBuildInfo(path) {
  return JSON.parse(execFileSync(path, ['--build-info-json'], {
    encoding: 'utf8', timeout: 20_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

function binaryFileName(binary, platform) {
  return platform === 'win32' ? `${binary}.exe` : binary;
}

async function assertRuntimeAbsent(directory) {
  try {
    const entries = await readdir(directory);
    if (entries.length > 0) throw new Error('RUNTIME_PREEXISTING');
  } catch (error) {
    if (error?.message === 'RUNTIME_PREEXISTING' || error?.code !== 'ENOENT') throw error;
  }
}

async function copyBinary(from, to) {
  await copyFile(from, to);
  if (process.platform !== 'win32') {
    await chmod(to, 0o755);
    await access(to, constants.X_OK);
  }
  if (await fileDigest(to) !== await fileDigest(from)) throw new Error('NATIVE_BUILD_COPY_CHANGED');
}

const platform = arg('--platform');
const arch = arg('--arch');
const sourceRoot = resolve(arg('--source'));
const upstream = resolve(arg('--upstream'));
const stageParent = resolve(arg('--stage'));
if (process.platform !== platform || process.arch !== arch) {
  throw new Error(`HOST_PLATFORM_MISMATCH:${process.platform}/${process.arch}`);
}
const expectedTarget = TARGETS[`${platform}:${arch}`];
if (!expectedTarget) throw new Error(`UNSUPPORTED_RUNTIME:${platform}/${arch}`);

const runtimeRoot = join(sourceRoot, 'runtime');
const runtimeDir = join(runtimeRoot, `${platform}-${arch}`);
await assertRuntimeAbsent(runtimeRoot);

const baseline = JSON.parse(await readFile(join(sourceRoot, 'upstream', 'baseline.json'), 'utf8'));
if (!/^[a-f0-9]{40}$/u.test(baseline.commit) || !/^v\d+\.\d+\.\d+$/u.test(baseline.ref) ||
    baseline.ref !== `v${baseline.version}` || baseline.patch !== 'upstream/remotemcp.patch' ||
    baseline.repository !== 'https://github.com/yyjeqhc/webcodex.git') {
  throw new Error('NATIVE_BUILD_INVALID_BASELINE');
}
const upstreamStat = await lstat(upstream);
if (!upstreamStat.isDirectory() || upstreamStat.isSymbolicLink()) throw new Error('NATIVE_BUILD_UNSAFE_INPUT');
const upstreamPatchSha256 = await fileDigest(join(sourceRoot, baseline.patch));
const source = await nativeSourceIdentity(upstream, baseline);

const builtDir = resolve(upstream, 'target', 'dogfood');
const hashes = {};
const built = {};
for (const binary of BUILT_BINARIES) {
  const path = join(builtDir, binaryFileName(binary, platform));
  if (!path.startsWith(`${builtDir}${sep}`)) throw new Error('NATIVE_BUILD_UNSAFE_INPUT');
  hashes[binary] = await fileDigest(path);
  built[binary] = validateBinary(readBuildInfo(path), binary, baseline, source, arch, expectedTarget);
}
if (built['webcodex-server'].agent_protocol_generation !== built['webcodex-runner'].agent_protocol_generation ||
    new Set(BUILT_BINARIES.map(binary => built[binary].built_at)).size !== 1 ||
    new Set(BUILT_BINARIES.map(binary => built[binary].target)).size !== 1) {
  throw new Error('NATIVE_BUILD_BINARY_SET_MISMATCH');
}

await mkdir(runtimeDir, { recursive: true });
const files = {};
for (const binary of PACKAGED_BINARIES) {
  const name = binaryFileName(binary, platform);
  await copyBinary(join(builtDir, name), join(runtimeDir, name));
  files[binary] = hashes[binary];
}
const buildInfo = {
  product: 'CodeFerry Preview',
  upstream: baseline,
  upstreamPatchSha256,
  source,
  profile: 'dogfood',
  sourcePatched: source.patched,
  platform,
  architecture: arch,
  builtAt: new Date().toISOString(),
  sha256: files,
  binaries: built,
  server: { sha256: hashes['webcodex-server'], buildInfo: built['webcodex-server'] },
};
await writeFile(join(runtimeDir, 'BUILD_INFO.json'), `${JSON.stringify(buildInfo, null, 2)}\n`, { flag: 'wx' });
for (const binary of PACKAGED_BINARIES) {
  if (await fileDigest(join(runtimeDir, binaryFileName(binary, platform))) !== files[binary]) {
    throw new Error('NATIVE_BUILD_COPY_CHANGED');
  }
}

const staged = join(stageParent, 'runtime');
if (basename(staged) !== 'runtime' || staged === sourceRoot || staged.startsWith(`${sourceRoot}${sep}`)) {
  throw new Error('RUNTIME_STAGE_INVALID');
}
await rm(staged, { recursive: true, force: true });
await mkdir(stageParent, { recursive: true });
await cp(runtimeDir, staged, { recursive: true });
for (const binary of PACKAGED_BINARIES) {
  const name = binaryFileName(binary, platform);
  if (process.platform !== 'win32') await chmod(join(staged, name), 0o755);
  if (await fileDigest(join(staged, name)) !== files[binary]) throw new Error('NATIVE_BUILD_COPY_CHANGED');
}

const packagePath = join(sourceRoot, 'desktop', 'scripts', 'package.mjs');
const needle = 'extraResource: [runtime],';
const replacement = `extraResource: [${JSON.stringify(staged)}],`;
const original = await readFile(packagePath, 'utf8');
if (!original.includes(needle)) throw new Error('PACKAGER_RESOURCE_LINE_MISSING');
const patched = original.replace(needle, replacement);
if (patched.includes(needle) || !patched.includes(replacement)) throw new Error('PACKAGER_RESOURCE_LINE_AMBIGUOUS');
await writeFile(packagePath, patched);
execFileSync(process.execPath, ['--check', packagePath], { stdio: 'inherit' });
console.log(`runtime ${platform}-${arch} target=${expectedTarget} revision=${source.revision}`);
