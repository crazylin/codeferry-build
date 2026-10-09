import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('security review workflow pins requested source and never publishes or deploys', async () => {
  const workflow = await readFile(new URL('../../workflows/security-review-ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^  push:/m);
  assert.match(workflow, /SOURCE_COMMIT_MUST_BE_EXACT_SHA/);
  assert.match(workflow, /ref: \$\{\{ inputs\.source_commit \}\}/);
  assert.match(workflow, /Verify immutable source identity/);
  assert.match(workflow, /Verify immutable source checkout/);
  assert.match(workflow, /TEST_DATABASE_URL:/);
  assert.match(workflow, /TEST_REDIS_URL:/);
  assert.match(workflow, /--include-ignored --test-threads=1/);
  assert.match(workflow, /macOS native desktop review/);
  assert.match(workflow, /native-guard-process-tree python3 desktop-tauri\/scripts\/runner_guard_fixture\.py/);
  assert.match(workflow, /native-guard-build cargo build --locked --profile dogfood/);
  for (const forbidden of ['prepare-release:', 'publish:', 'deploy:', 'publish-server.mjs', 'docker push', 'gh release edit', 'deploy_gateway', 'private-cache.mjs save']) {
    assert.ok(!workflow.includes(forbidden), `Security CI must not do ${forbidden}`);
  }
});
