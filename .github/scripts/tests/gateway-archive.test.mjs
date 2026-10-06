import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('Docker exporter canonicalization preserves verified image and rejects ambiguous extras', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = resolve(here, '../../..');
  let worker = join(repo, 'source/deploy/1panel/release-worker.py');
  try { await access(worker); }
  catch { worker = resolve(repo, '../../deploy/1panel/release-worker.py'); }
  const output = execFileSync('python3', [join(here, 'gateway_archive_test.py'), worker], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(output, '');
});
