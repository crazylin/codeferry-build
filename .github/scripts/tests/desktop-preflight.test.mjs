import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../../workflows/desktop-diagnostics.yml', import.meta.url), 'utf8');

test('manual desktop diagnostics never sign, publish or replace a real Runner acceptance gate', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\n  push:|pull_request|CODEFERRY_PUBLISH_KEY|TAURI_SIGNING_PRIVATE_KEY|publish-private-asset|prepare-private-release|tauri build|native-build\.mjs/);
  assert.match(workflow, /source_commit:[\s\S]*required: true/);
  assert.match(workflow, /git -C source rev-parse HEAD/);
  assert.match(workflow, /cargo test --manifest-path src-tauri\/Cargo\.toml --locked --no-run/);
  assert.doesNotMatch(workflow, /--include-ignored/);
});
test('desktop preflight uses the production platform/toolchain/cache and private failure collector', () => {
  for (const platform of ['macos-15', 'windows-2025', 'ubuntu-24.04']) assert.ok(workflow.includes(platform));
  for (const action of workflow.matchAll(/uses:\s*\S+@(\S+)/g)) assert.match(action[1], /^[a-f0-9]{40}$/);
  assert.match(workflow, /node-version: '22\.13\.1'/);
  assert.match(workflow, /toolchain: '1\.96\.0'/);
  const restore = workflow.indexOf('private-cache.mjs restore desktop-');
  const build = workflow.indexOf('tauri-contracts cargo test');
  const save = workflow.indexOf('private-cache.mjs save desktop-');
  assert.ok(restore > 0 && restore < build && save > build);
  assert.match(workflow, /if: failure\(\)[\s\S]*CODEFERRY_DIAGNOSTIC_ROLE:[\s\S]*save-private-diagnostics\.mjs/);
  assert.doesNotMatch(workflow, /upload-artifact|actions\/cache|Swatin\/rust-cache/);
});
