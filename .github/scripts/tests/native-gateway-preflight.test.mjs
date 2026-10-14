import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { fixtureSources, fixtureBuildEnvironment, assertFixtureArchive, isExactFixtureVersion, waitFixtureCommand } from '../prepare-native-e2e-fixtures.mjs';
import { diagnosticTasks } from '../save-private-diagnostics.mjs';

const workflow = await readFile(new URL('../../workflows/desktop-diagnostics.yml', import.meta.url), 'utf8');
const installer = await readFile(new URL('../prepare-native-e2e-fixtures.mjs', import.meta.url), 'utf8');
const native = workflow.match(/^  native-e2e:\n([\s\S]*)$/m)?.[1];

test('native Gateway E2E is a separate explicit Mac ARM preflight choice', () => {
  assert.ok(native);
  assert.match(workflow, /options: \[all, win32, backend, native-e2e\]/);
  assert.match(workflow, /preflight:[\s\S]*if: inputs\.platform == 'all' \|\| inputs\.platform == 'win32'/);
  assert.match(native, /if: inputs\.platform == 'native-e2e'/);
  assert.match(native, /runs-on: macos-15/);
  assert.match(native, /timeout-minutes: 120/);
  assert.match(native, /test "\$\(uname -m\)" = arm64/);
  assert.doesNotMatch(workflow, /^  push:|pull_request|TAURI_SIGNING_PRIVATE_KEY|CODEFERRY_PUBLISH_KEY|publish-private-asset|prepare-private-release|tauri build|deploy_gateway|docker push/m);
});

test('native E2E binds one exact private source checkout and pinned build tools', () => {
  assert.match(native, /SOURCE_COMMIT_MUST_BE_EXACT_SHA/);
  assert.match(native, /test "\$\(git -C source rev-parse HEAD\)" = "\$SOURCE_SHA"/);
  assert.match(native, /ref: \$\{\{ inputs\.source_commit \}\}/);
  assert.match(native, /persist-credentials: false/);
  assert.match(native, /node-version: '22\.13\.1'/);
  assert.match(native, /toolchain: '1\.96\.0'/);
  assert.match(native, /RUSTUP_TOOLCHAIN: '1\.96\.0'/);
  for (const action of native.matchAll(/uses:\s*\S+@(\S+)/g)) assert.match(action[1], /^[a-f0-9]{40}$/);
});

test('prepared production runtime Gateway and controller frontend precede source acceptance', () => {
  const stages = [
    'root-dependencies npm ci',
    'tauri-dependencies npm ci',
    'native-source node .github/scripts/prepare-source.mjs',
    'private-cache.mjs restore desktop-darwin-arm64',
    'private-cache.mjs restore validate-darwin-arm64',
    'native-runtime node scripts/native-build.mjs',
    'tauri-frontend-build npm run build',
    'gateway-build cargo build --locked --manifest-path gateway-rs/Cargo.toml',
    'native-fixtures node .github/scripts/prepare-native-e2e-fixtures.mjs',
    'native-gateway-acceptance node scripts/native-gateway-acceptance.mjs',
    'private-cache.mjs save desktop-darwin-arm64',
    'private-cache.mjs save validate-darwin-arm64',
  ].map(stage => native.indexOf(stage));
  assert.ok(stages.every((position, index) => position >= 0 && (!index || stages[index - 1] < position)));
  assert.match(native, /CODEFERRY_NATIVE_PROFILE: 'release'/);
  assert.match(native, /export PATH="\$RUNNER_TEMP\/codeferry-native-fixtures\/bin:\$PATH"/);
  assert.doesNotMatch(native, /--include-ignored|--test-name-pattern|\.test\.js/);
});

test('native E2E exposes no database production credentials or public test artifacts', () => {
  assert.doesNotMatch(native, /private\/server\.env|DATABASE_URL:|REDIS_URL:|BOOTSTRAP_TOKEN:|upload-artifact|actions\/cache|Swatin\/rust-cache|--log-failed|printenv|set -x|brew services/);
  assert.match(native, /if: failure\(\)[\s\S]*CODEFERRY_DIAGNOSTIC_ROLE: darwin-arm64[\s\S]*save-private-diagnostics\.mjs/);
  assert.ok(diagnosticTasks.includes('native-fixtures'));
  assert.ok(diagnosticTasks.includes('native-gateway-acceptance'));
  assert.doesNotMatch(installer, /brew install|brew services|GITHUB_ENV|GITHUB_PATH|sudo/);
});

test('fixture preparation fixes official source versions URLs and SHA-256 identities', () => {
  assert.deepEqual(fixtureSources.postgres, {
    version: '16.15', archive: 'postgresql-16.15.tar.bz2',
    url: 'https://ftp.postgresql.org/pub/source/v16.15/postgresql-16.15.tar.bz2',
    sha256: 'c1575341fa7bd40f5274ea465b34390f4dc64cdd0770af327005caaeb9f6b7ed',
  });
  assert.deepEqual(fixtureSources.redis, {
    version: '8.10.2', archive: 'redis-8.10.2.tar.gz',
    url: 'https://download.redis.io/releases/redis-8.10.2.tar.gz',
    sha256: 'b9ffee226b5eecdba98a679260dad764b2a4ebd90dce4ad5ac9e9f3eef9c02b3',
  });
  assert.match(installer, /redirect: 'error'/);
  assert.match(installer, /await mkdir\(root, \{ mode: 0o700 \}\)/);
  assert.match(installer, /await download\(definition, archive\)/);
  assert.match(installer, /assertFixtureArchive\(bytes, definition\)/);
  assert.match(installer, /if \(!await exactTools\(directory, tools, definition, env\)\)/);
});

test('fixture builder clears inherited credentials and compiler override environment', () => {
  const environment = { PATH: '/usr/bin', HOME: '/private/home', LANG: 'en_US.UTF-8', SDKROOT: '/sdk',
    GH_TOKEN: 'fixture-secret', GITHUB_TOKEN: 'fixture-secret', CODEFERRY_SOURCE_TOKEN: 'fixture-secret',
    REMOTEMCP_BOOTSTRAP_TOKEN: 'fixture-secret', TAURI_SIGNING_PRIVATE_KEY: 'fixture-secret',
    DATABASE_URL: 'postgres://unrelated/production', REDIS_URL: 'redis://unrelated',
    CC: '/unrelated/cc', CFLAGS: 'inherited-override', MAKEFLAGS: 'inherited-override',
    NODE_OPTIONS: '--require /unrelated/code.js', DYLD_INSERT_LIBRARIES: '/unrelated/library' };
  assert.deepEqual(fixtureBuildEnvironment(environment), { PATH: '/usr/bin', HOME: '/private/home', LANG: 'en_US.UTF-8', SDKROOT: '/sdk' });
});

test('fixture versions are exact and archive corruption cannot pass', () => {
  assert.ok(isExactFixtureVersion('postgres', 'pg_ctl', 'pg_ctl (PostgreSQL) 16.15'));
  assert.ok(isExactFixtureVersion('redis', 'redis-server', 'Redis server v=8.10.2 sha=00000000:0 malloc=libc bits=64'));
  assert.ok(isExactFixtureVersion('redis', 'redis-cli', 'redis-cli 8.10.2'));
  for (const value of ['16.14', '16.150', '17.15']) assert.equal(isExactFixtureVersion('postgres', 'initdb', `initdb (PostgreSQL) ${value}`), false);
  for (const value of ['8.10.1', '8.10.20', '8.12.0']) assert.equal(isExactFixtureVersion('redis', 'redis-server', `Redis server v=${value}`), false);
  assert.equal(isExactFixtureVersion('redis', 'unexpected-tool', 'Redis server v=8.10.2'), false);
  const bytes = Buffer.from('fixture archive');
  const identity = { sha256: createHash('sha256').update(bytes).digest('hex') };
  assertFixtureArchive(bytes, identity);
  assert.throws(() => assertFixtureArchive(Buffer.concat([bytes, Buffer.from('corruption')]), identity), /NATIVE_FIXTURE_ARCHIVE_INVALID/);
  assert.throws(() => assertFixtureArchive(Buffer.alloc(0), identity), /NATIVE_FIXTURE_ARCHIVE_INVALID/);
});

function heldChild(onSignal = () => {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null; child.signalCode = null;
  child.signals = []; child.released = false;
  child.kill = signal => { child.signals.push(signal); onSignal(child, signal); return true; };
  child.unref = () => { child.released = true; };
  return child;
}
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test('timeout settles with unknown cleanup when an exited leader leaves pipes open, without signaling a reused PID', async () => {
  const child = heldChild((held, signal) => {
    if (signal === 'SIGTERM') { held.signalCode = signal; held.emit('exit', null, signal); }
  });
  await assert.rejects(waitFixtureCommand(child, { timeout: 5, stopGraceMs: 15 }), /NATIVE_FIXTURE_COMMAND_CLEANUP_UNKNOWN/);
  await delay(20);
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(child.stdout.destroyed, true); assert.equal(child.stderr.destroyed, true);
  assert.equal(child.released, true);
});

test('a successful leader exit without pipe closure cannot become success or trigger a stale signal', async () => {
  const child = heldChild();
  const result = waitFixtureCommand(child, { timeout: 10, stopGraceMs: 20 });
  child.exitCode = 0; child.emit('exit', 0, null);
  await assert.rejects(result, /NATIVE_FIXTURE_COMMAND_CLEANUP_UNKNOWN/);
  assert.deepEqual(child.signals, []);
});

test('synchronous TERM exit and close preserve timeout failure and cancel escalation', async () => {
  const child = heldChild((held, signal) => {
    held.signalCode = signal; held.emit('exit', null, signal); held.emit('close', null, signal);
  });
  await assert.rejects(waitFixtureCommand(child, { timeout: 5, stopGraceMs: 15 }), /NATIVE_FIXTURE_COMMAND_TIMEOUT/);
  await delay(20);
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('output limits stay bounded and kill only a still-held child at settlement cutoff', async () => {
  const child = heldChild();
  const result = waitFixtureCommand(child, { timeout: 100, stopGraceMs: 10, outputLimit: 4 });
  child.stderr.write('raw compiler private text');
  await assert.rejects(result, /NATIVE_FIXTURE_COMMAND_CLEANUP_UNKNOWN/);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(child.stderr.destroyed, true);
});
