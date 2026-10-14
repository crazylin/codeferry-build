import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../../workflows/desktop-diagnostics.yml', import.meta.url), 'utf8');
const backend = workflow.match(/^  backend:\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|(?![\s\S]))/m)?.[1];

test('backend diagnostics is explicitly selected without changing existing desktop choices', () => {
  assert.ok(backend);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /options: \[all, win32, backend, native-e2e\]/);
  assert.match(workflow, /preflight:[\s\S]*if: inputs\.platform == 'all' \|\| inputs\.platform == 'win32'/);
  assert.match(backend, /if: inputs\.platform == 'backend'/);
  assert.match(backend, /runs-on: ubuntu-24\.04/);
  assert.match(backend, /timeout-minutes: 120/);
  assert.doesNotMatch(workflow, /^  push:|pull_request|CODEFERRY_PUBLISH_KEY|TAURI_SIGNING_PRIVATE_KEY|publish-private-asset|prepare-private-release|tauri build|deploy_gateway|docker push/m);
});

test('backend services are isolated fixture endpoints and use immutable image digests', () => {
  assert.match(backend, /TEST_DATABASE_URL: postgres:\/\/codeferry:fixture-ci-password@127\.0\.0\.1:5432\/codeferry_test\n/);
  assert.match(backend, /TEST_REDIS_URL: redis:\/\/127\.0\.0\.1:6379\/0\n/);
  assert.match(backend, /POSTGRES_DB: codeferry_test\n/);
  for (const service of ['postgres', 'redis']) {
    assert.match(backend, new RegExp('image: ' + service + '@sha256:[a-f0-9]{64}\\n'));
  }
  assert.match(backend, /--health-retries 20/);
  assert.doesNotMatch(backend, /private\/server\.env|REMOTEMCP_BOOTSTRAP_TOKEN|REMOTEMCP_NATIVE_ORIGIN|REDIS_URL: \$\{|DATABASE_URL: \$\{/);
});

test('backend pins source and toolchain then invokes source acceptance after patch reproduction', () => {
  assert.match(backend, /SOURCE_COMMIT_MUST_BE_EXACT_SHA/);
  assert.match(backend, /git -C source rev-parse HEAD/);
  assert.match(backend, /ref: \$\{\{ inputs\.source_commit \}\}/);
  assert.match(backend, /node-version: '22\.13\.1'/);
  assert.match(backend, /RUSTUP_TOOLCHAIN: '1\.96\.0'/);
  assert.match(backend, /toolchain: '1\.96\.0'/);
  for (const action of backend.matchAll(/uses:\s*\S+@(\S+)/g)) assert.match(action[1], /^[a-f0-9]{40}$/);
  const prepare = backend.indexOf('native-source node .github/scripts/prepare-source.mjs');
  const contracts = backend.indexOf('root-contracts npm test');
  const restore = backend.indexOf('private-cache.mjs restore validate-linux-x64');
  const acceptance = backend.indexOf('gateway-contracts node scripts/backend-acceptance.mjs');
  const save = backend.indexOf('private-cache.mjs save validate-linux-x64');
  assert.ok(prepare > 0 && prepare < contracts && contracts < restore && restore < acceptance && acceptance < save);
  assert.doesNotMatch(backend, /gateway-contracts cargo test/);
});

test('backend raw source and test diagnostics remain private and bounded', () => {
  assert.match(backend, /if: failure\(\)[\s\S]*CODEFERRY_DIAGNOSTIC_ROLE: validate[\s\S]*save-private-diagnostics\.mjs/);
  assert.match(backend, /gateway-contracts node scripts\/backend-acceptance\.mjs/);
  assert.match(backend, /timeout-minutes: 15/);
  assert.doesNotMatch(backend, /upload-artifact|actions\/cache|Swatin\/rust-cache|--log-failed|printenv|set -x/);
});
