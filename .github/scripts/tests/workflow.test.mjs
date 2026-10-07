import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const text = await readFile(join(repo, '.github/workflows/desktop-clients.yml'), 'utf8');
const cleanup = await readFile(join(repo, '.github/workflows/delete-build-logs.yml'), 'utf8');
function job(name) { const match = text.match(new RegExp('^  ' + name + ':\\n([\\s\\S]*?)(?=^  [a-z-]+:|$(?![\\s\\S]))', 'm')); assert.ok(match, name); return match[1]; }

test('successful build cleanup removes logs without deleting run status or failed diagnostics', () => {
  assert.ok(cleanup.includes("if: ${{ github.event.workflow_run.conclusion == 'success' }}"));
  const runCommands = cleanup.split('\n').filter(line => line.trimStart().startsWith('run:'));
  assert.deepEqual(runCommands, ['        run: gh api --method DELETE /repos/crazylin/codeferry-build/actions/runs/${{ github.event.workflow_run.id }}/logs']);
});

test('workflow pins platforms, Node, Rust, actions and one immutable source revision', () => {
  assert.match(text, /ubuntu-24\.04/); assert.match(text, /windows-2025/); assert.match(text, /macos-15/);
  for (const match of text.matchAll(/uses:\s*([^\s]+)@([^\s]+)/g)) assert.match(match[2], /^[a-f0-9]{40}$/);
  assert.equal([...text.matchAll(/node-version: '22\.13\.1'/g)].length, 4);
  assert.equal([...text.matchAll(/toolchain: '1\.96\.0', components: rustfmt/g)].length, 3);
  assert.equal([...text.matchAll(/ref: \$\{\{ needs\.resolve\.outputs\.source_sha \}\}/g)].length, 4);
  assert.doesNotMatch(text, /pull_request|pull_request_target|ubuntu-latest|windows-latest|macos-latest/);
});
test('native source preparation precedes Cargo and source authoritative Runner script is used', () => {
  assert.ok(job('gateway').indexOf('prepare-source.mjs') < job('gateway').indexOf('cargo build'));
  assert.ok(job('validate').indexOf('prepare-source.mjs') < job('validate').indexOf('cargo fmt'));
  assert.match(job('package'), /node scripts\/native-build\.mjs/);
  assert.doesNotMatch(text, /stage-desktop-runtime|--bin webcodex-runner/);
});
test('each fresh package checkout builds embedded frontend assets before Tauri Cargo tests', () => {
  const packageJob = job('package');
  const install = packageJob.indexOf('tauri-dependencies npm ci');
  const build = packageJob.indexOf('tauri-frontend-build npm run build');
  const nativeTest = packageJob.indexOf('tauri-contracts cargo test');
  assert.notEqual(install, -1);
  assert.notEqual(build, -1);
  assert.notEqual(nativeTest, -1);
  assert.ok(install < build && build < nativeTest);
  assert.match(packageJob, /Typecheck build frontend and test complete Rust client\n        shell: bash/);
  assert.match(packageJob, /set -euo pipefail\n          node .*tauri-types/);
});
test('validation builds the Tauri frontend without retired Electron runtime contracts', () => {
  const validation = job('validate');
  assert.match(validation, /working-directory: source\/desktop-tauri/);
  assert.match(validation, /tauri-frontend-dependencies npm ci/);
  assert.match(validation, /tauri-frontend-types npm run typecheck/);
  assert.match(validation, /tauri-frontend-build npm run build/);
  assert.doesNotMatch(validation, /working-directory: source\/desktop\n|ELECTRON_SKIP_BINARY_DOWNLOAD|desktop-contracts/);
});
test('all builds and actual database/native tests precede publisher key access', () => {
  assert.match(job('validate'), /TEST_DATABASE_URL/); assert.match(job('validate'), /TEST_REDIS_URL/);
  assert.match(job('validate'), /--include-ignored/); assert.match(job('validate'), /release_worker_test\.py/);
  assert.match(job('gateway'), /gateway-smoke\.mjs/); assert.match(job('gateway'), /collect-gateway\.mjs/);
  assert.match(job('publish'), /needs: \[resolve, validate, package, gateway\]/);
  assert.equal([...text.matchAll(/secrets\.CODEFERRY_PUBLISH_KEY/g)].length, 1);
  assert.ok(job('publish').includes('secrets.CODEFERRY_PUBLISH_KEY'));
  assert.doesNotMatch(text, /TAURI_PRODUCTION_RELEASE_NOT_READY|client_engine:/);
  assert.match(job('package'), /secrets\.TAURI_SIGNING_PRIVATE_KEY/);
  assert.doesNotMatch(job('publish'), /secrets\.TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(job('package'), /tauri build --bundles/);
  assert.match(job('package'), /platform: darwin, arch: arm64, runner: 'codeferry-runner', bundles: 'app'/);
  assert.ok(job('package').indexOf('tauri build --bundles') < job('package').indexOf('finalize-macos-package.mjs'));
  assert.match(job('package'), /cargo test --manifest-path src-tauri\/Cargo.toml --locked/);
  assert.doesNotMatch(job('package'), /electron|slim|npm run package/);
  assert.match(job('publish'), /needs\.package\.result == 'success'/);
  assert.match(job('publish'), /needs\.package\.result == 'skipped'/);
});
test('archive scripts do not overwrite releases or wrap application ZIP in source tarballs', async () => {
  const uploads = await readFile(join(repo, '.github/scripts/publish-private-asset.sh'), 'utf8');
  assert.doesNotMatch(uploads.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n'), /--clobber/);
  assert.doesNotMatch(job('package'), /tar -cz|tar -cf/);
  assert.match(job('gateway'), /noclobber/);
  const helper = await readFile(join(repo, '.github/scripts/gateway-image.mjs'), 'utf8');
  assert.match(helper, /--provenance=false/); assert.match(helper, /--sbom=false/);
  assert.match(helper, /--stage-only/); assert.match(helper, /GATEWAY_BINARY/);
});

test('Python application ZIP preserves executable mode, internal links, and refuses overwrite/escape', () => {
  execFileSync('python3', ['-c', `import importlib.util,pathlib,tempfile,zipfile,os,stat
spec=importlib.util.spec_from_file_location('zipper',${JSON.stringify(join(repo, '.github/scripts/zip-desktop.py'))});mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
with tempfile.TemporaryDirectory() as temp:
 root=pathlib.Path(temp);app=root/'app';app.mkdir();binary=app/'CodeFerry';binary.write_bytes(b'fixture');binary.chmod(0o755);os.symlink('CodeFerry',app/'link');archive=root/'app.zip';mod.create_zip(app,archive)
 with zipfile.ZipFile(archive) as z:
  assert set(z.namelist())=={'CodeFerry/CodeFerry','CodeFerry/link'}
  assert (z.getinfo('CodeFerry/CodeFerry').external_attr>>16)&0o111
  assert stat.S_ISLNK(z.getinfo('CodeFerry/link').external_attr>>16)
 try:mod.create_zip(app,archive)
 except FileExistsError:pass
 else:raise AssertionError('overwritten')
 os.symlink('../secret',app/'escape')
 try:mod.create_zip(app,root/'unsafe.zip')
 except ValueError:pass
 else:raise AssertionError('unsafe link accepted')
`], { stdio: 'pipe' });
});
test('migration identity is canonical SQLx SHA384 sorted by numeric version with immutable output', async () => {
  const source = resolve(repo, 'source');
  let path = join(source, 'scripts/release-image-info.py');
  try { await access(path); } catch { path = resolve(repo, '../../scripts/release-image-info.py'); }
  execFileSync('python3', ['-c', `import importlib.util,pathlib,tempfile,hashlib,json,os
spec=importlib.util.spec_from_file_location('identity',${JSON.stringify(path)});mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
with tempfile.TemporaryDirectory() as temp:
 root=pathlib.Path(temp);(root/'10_ten.sql').write_bytes(b'SELECT 10;');(root/'2_two.sql').write_bytes(b'SELECT 2;')
 rows,data,digest=mod.migration_identity(root)
 assert rows==[{'version':2,'checksum':hashlib.sha384(b'SELECT 2;').hexdigest()},{'version':10,'checksum':hashlib.sha384(b'SELECT 10;').hexdigest()}]
 assert data==json.dumps(rows,separators=(',',':')).encode();assert digest==hashlib.sha256(data).hexdigest()
 (root/'02_duplicate.sql').write_bytes(b'SELECT 2;')
 try:mod.migration_identity(root)
 except ValueError:pass
 else:raise AssertionError('duplicate accepted')
 (root/'02_duplicate.sql').unlink();os.symlink(root/'2_two.sql',root/'3_link.sql')
 try:mod.migration_identity(root)
 except ValueError:pass
 else:raise AssertionError('symlink accepted')
`], { stdio: 'pipe' });
});


test('fresh contract tests have Tauri dependencies and reproduced native source before running', () => {
  const validation = job('validate');
  const root = validation.indexOf('root-dependencies npm ci');
  const frontend = validation.indexOf('tauri-frontend-dependencies npm ci');
  const native = validation.indexOf('native-source node .github/scripts/prepare-source.mjs');
  const contracts = validation.indexOf('root-contracts npm test');
  assert.ok([root, frontend, native, contracts].every(index => index >= 0));
  assert.ok(root < contracts && frontend < contracts && native < contracts);
  assert.match(validation, /native-auth cargo test --locked -p webcodex --lib auth::/);
});
