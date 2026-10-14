/** Exact test-service sources; no global installation or service enrollment. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const fixtureSources = Object.freeze({
  postgres: Object.freeze({
    version: '16.15',
    archive: 'postgresql-16.15.tar.bz2',
    url: 'https://ftp.postgresql.org/pub/source/v16.15/postgresql-16.15.tar.bz2',
    sha256: 'c1575341fa7bd40f5274ea465b34390f4dc64cdd0770af327005caaeb9f6b7ed',
  }),
  redis: Object.freeze({
    version: '8.10.2',
    archive: 'redis-8.10.2.tar.gz',
    url: 'https://download.redis.io/releases/redis-8.10.2.tar.gz',
    sha256: 'b9ffee226b5eecdba98a679260dad764b2a4ebd90dce4ad5ac9e9f3eef9c02b3',
  }),
});
const postgresTools = ['postgres', 'initdb', 'pg_ctl', 'psql', 'createdb', 'pg_isready'];
const redisTools = ['redis-server', 'redis-cli'];
const allowedEnvironment = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'SDKROOT', 'MACOSX_DEPLOYMENT_TARGET', 'DEVELOPER_DIR']);
const MAX_DOWNLOAD = 128 * 1024 ** 2;
const MAX_OUTPUT = 4 * 1024 ** 2;
const fail = code => { throw Error(code); };

export function fixtureBuildEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => allowedEnvironment.has(key)));
}
export function assertFixtureArchive(bytes, source) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_DOWNLOAD ||
      createHash('sha256').update(bytes).digest('hex') !== source.sha256) fail('NATIVE_FIXTURE_ARCHIVE_INVALID');
}

export function isExactFixtureVersion(kind, tool, output) {
  const definition = fixtureSources[kind];
  if (!definition || typeof output !== 'string' || output.length > 4096) return false;
  const version = definition.version.replaceAll('.', '\\.');
  if (kind === 'postgres' && postgresTools.includes(tool)) return new RegExp(`^${tool} \\(PostgreSQL\\) ${version}(?:\\s|$)`).test(output);
  if (kind === 'redis' && tool === 'redis-server') return new RegExp(`^Redis server v=${version}(?:\\s|$)`).test(output);
  if (kind === 'redis' && tool === 'redis-cli') return new RegExp(`^redis-cli ${version}(?:\\s|$)`).test(output);
  return false;
}

/** Direct-child evidence only; timeout never certifies descendant cleanup. */
export function waitFixtureCommand(child, { timeout = 15 * 60_000, stopGraceMs = 1500, outputLimit = MAX_OUTPUT } = {}) {
  return new Promise((accept, reject) => {
    let bytes = 0, stdout = [], done = false, exited = false, failure, cutoff;
    const finish = error => {
      if (done) return;
      done = true; clearTimeout(deadline); clearTimeout(cutoff);
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      const output = error ? undefined : Buffer.concat(stdout).toString('utf8').trim();
      stdout = [];
      if (error) reject(Error(error)); else accept(output);
    };
    const signalHeldChild = signal => {
      if (done || exited || child.exitCode !== null || child.signalCode !== null) return;
      try { child.kill(signal); } catch {}
    };
    const boundSettlement = () => {
      if (cutoff || done) return;
      cutoff = setTimeout(() => {
        // A reaped leader is not authority to signal its former process group.
        // A still-held leader may be killed, but its descendant result remains
        // unknown when pipe closure cannot be observed before this deadline.
        signalHeldChild('SIGKILL');
        finish('NATIVE_FIXTURE_COMMAND_CLEANUP_UNKNOWN');
      }, stopGraceMs);
    };
    const interrupt = code => {
      if (failure || done) return;
      failure = code;
      boundSettlement();
      signalHeldChild('SIGTERM');
    };
    const collect = (chunk, output) => {
      if (done || failure) return;
      bytes += chunk.length;
      if (bytes > outputLimit) interrupt('NATIVE_FIXTURE_COMMAND_OUTPUT_LIMIT');
      else if (output) stdout.push(chunk);
    };
    const deadline = setTimeout(() => interrupt('NATIVE_FIXTURE_COMMAND_TIMEOUT'), timeout);
    child.stdout.on('data', chunk => collect(chunk, true));
    // Compiler stderr is counted but never retained or exposed.
    child.stderr.on('data', chunk => collect(chunk, false));
    child.once('error', () => interrupt('NATIVE_FIXTURE_COMMAND_FAILED'));
    child.once('exit', () => { exited = true; boundSettlement(); });
    child.once('close', (code, signal) => {
      exited = true;
      finish(failure ?? (code === 0 && !signal ? undefined : 'NATIVE_FIXTURE_COMMAND_FAILED'));
    });
  });
}

async function command(file, args, environment, options = {}) {
  const child = spawn(file, args, { env: environment, cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  return waitFixtureCommand(child, { timeout: options.timeout });
}

async function exactTools(directory, tools, definition, environment) {
  if (!isAbsolute(directory)) return false;
  for (const tool of tools) {
    try {
      const path = await realpath(join(directory, tool));
      if (!(await lstat(path)).isFile()) return false;
      const output = await command(path, ['--version'], environment, { timeout: 10_000 });
      if (!isExactFixtureVersion(tools === postgresTools ? 'postgres' : 'redis', tool, output)) return false;
    } catch { return false; }
  }
  return true;
}

async function existingTools(tools, definition, environment) {
  const candidates = tools === postgresTools ?
    ['/opt/homebrew/opt/postgresql@16/bin', '/usr/local/opt/postgresql@16/bin'] :
    ['/opt/homebrew/opt/redis/bin', '/usr/local/opt/redis/bin'];
  candidates.push(...(environment.PATH ?? '').split(':').filter(isAbsolute));
  for (const directory of [...new Set(candidates)]) {
    if (await exactTools(directory, tools, definition, environment)) return directory;
  }
  return undefined;
}

async function download(definition, path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(definition.url, { signal: controller.signal, redirect: 'error' });
    if (!response.ok || Number(response.headers.get('content-length')) > MAX_DOWNLOAD) fail('NATIVE_FIXTURE_DOWNLOAD_FAILED');
    let length = 0; const chunks = [];
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > MAX_DOWNLOAD) { controller.abort(); fail('NATIVE_FIXTURE_ARCHIVE_INVALID'); }
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    assertFixtureArchive(bytes, definition);
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  } finally { clearTimeout(timer); }
}

async function compile(root, kind, definition, environment) {
  const archive = join(root, definition.archive), source = join(root, `${kind}-source`);
  const prefix = join(root, `${kind}-install`);
  await download(definition, archive);
  await mkdir(source, { mode: 0o700 });
  // Extraction follows only a fixed official archive whose full SHA-256 was
  // checked above; arbitrary workflow input cannot choose the archive or URL.
  await command('/usr/bin/tar', ['-xf', archive, '-C', source, '--strip-components=1'], environment);
  if (kind === 'postgres') {
    await command(join(source, 'configure'), [`--prefix=${prefix}`, '--without-readline', '--without-zlib', '--without-icu'], environment, { cwd: source });
    await command('make', ['-j2'], environment, { cwd: source });
    await command('make', ['install'], environment, { cwd: source });
  } else {
    await command('make', ['-j2', 'BUILD_TLS=no', 'MALLOC=libc', 'redis-server', 'redis-cli'], environment, { cwd: source });
    await mkdir(join(prefix, 'bin'), { recursive: true, mode: 0o700 });
    for (const tool of redisTools) await symlink(join(source, 'src', tool), join(prefix, 'bin', tool));
  }
  await rm(archive, { force: true });
  return join(prefix, 'bin');
}

export async function prepareNativeFixtures(temporary, environment = process.env, { reuseInstalled = true } = {}) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || !isAbsolute(temporary ?? '') ||
      temporary.length > 4096 || temporary.includes('\0')) fail('NATIVE_FIXTURE_PLATFORM_INVALID');
  const parent = await realpath(temporary);
  if (!(await lstat(parent)).isDirectory()) fail('NATIVE_FIXTURE_DIRECTORY_INVALID');
  const root = join(parent, 'codeferry-native-fixtures');
  // A previous or unrelated directory is not replaced.
  await mkdir(root, { mode: 0o700 });
  await mkdir(join(root, 'bin'), { mode: 0o700 });
  const env = fixtureBuildEnvironment(environment), records = [];
  for (const [kind, definition, tools] of [
    ['postgres', fixtureSources.postgres, postgresTools], ['redis', fixtureSources.redis, redisTools],
  ]) {
    const installed = reuseInstalled ? await existingTools(tools, definition, env) : undefined;
    const directory = installed ?? await compile(root, kind, definition, env);
    if (!await exactTools(directory, tools, definition, env)) fail('NATIVE_FIXTURE_VERSION_MISMATCH');
    for (const tool of tools) await symlink(await realpath(join(directory, tool)), join(root, 'bin', tool));
    records.push({ kind, version: definition.version, archiveSha256: definition.sha256,
      origin: installed ? 'exact-preinstalled' : 'verified-source' });
  }
  await writeFile(join(root, 'identity.json'), JSON.stringify({ schemaVersion: 1, platform: 'darwin', architecture: 'arm64', records }) + '\n', { flag: 'wx', mode: 0o600 });
  return records;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const records = await prepareNativeFixtures(process.env.RUNNER_TEMP);
    for (const record of records) console.log(`NATIVE_FIXTURE_READY ${record.kind} ${record.version} ${record.origin}`);
  } catch {
    // No inherited values, compiler source, local paths or raw download errors.
    console.error('NATIVE_FIXTURE_PREPARATION_FAILED'); process.exitCode = 1;
  }
}
