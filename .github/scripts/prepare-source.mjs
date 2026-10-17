/** Validate the single source checkout before running its authoritative setup. */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve('source');
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
if (!/^[a-f0-9]{40}$/.test(process.env.SOURCE_SHA ?? '') || sha !== process.env.SOURCE_SHA) throw Error('SOURCE_IDENTITY_INVALID');
const patch = await readFile(resolve(root, 'upstream/remotemcp.patch'));
if (patch.includes(13)) throw Error('PATCH_HAS_CRLF');
const baseline = JSON.parse(await readFile(resolve(root, 'upstream/baseline.json'), 'utf8'));
if (baseline.repository !== 'https://github.com/yyjeqhc/webcodex.git' ||
    !/^[a-f0-9]{40}$/.test(baseline.commit) || baseline.ref !== 'v' + baseline.version) throw Error('BASELINE_INVALID');
execFileSync(process.execPath, [resolve(root, 'scripts/upstream.mjs'), 'prepare'], { cwd: root, stdio: 'inherit' });
execFileSync(process.execPath, [resolve(root, 'scripts/verify-upstream.mjs')], { cwd: root, stdio: 'inherit' });
import { lstat, readdir, utimes } from 'node:fs/promises';

async function normalizeTreeMtime(dir, epoch) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'target' || entry.name === 'node_modules') continue;
    const full = resolve(dir, entry.name);
    const stat = await lstat(full);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) await normalizeTreeMtime(full, epoch);
    try { await utimes(full, epoch, epoch); } catch {}
  }
}

async function normalizeGitTrackedMtimes(repoRoot, subdirs, fallbackEpoch) {
  const logOut = execFileSync('git', ['log', '--format=__COMMIT__%ct', '--name-only', 'HEAD', '--', ...subdirs], {
    cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const seen = new Set();
  let currentEpoch = fallbackEpoch;
  for (const rawLine of logOut.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('__COMMIT__')) {
      const parsed = Number.parseInt(line.slice(10), 10);
      if (Number.isFinite(parsed) && parsed > 0) currentEpoch = parsed;
      continue;
    }
    if (seen.has(line)) continue;
    seen.add(line);
    const full = resolve(repoRoot, line);
    try {
      const stat = await lstat(full);
      if (!stat.isSymbolicLink()) await utimes(full, currentEpoch, currentEpoch);
    } catch {}
  }
}

const upstreamRoot = resolve(root, 'upstream/webcodex');
const baselineEpoch = Number.parseInt(
  execFileSync('git', ['show', '-s', '--format=%ct', baseline.commit], { cwd: upstreamRoot, encoding: 'utf8' }).trim(),
  10,
);
if (Number.isFinite(baselineEpoch) && baselineEpoch > 0) {
  await normalizeTreeMtime(upstreamRoot, baselineEpoch);
}
const sourceEpoch = Number.parseInt(
  execFileSync('git', ['show', '-s', '--format=%ct', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  10,
);
if (Number.isFinite(sourceEpoch) && sourceEpoch > 0) {
  await normalizeGitTrackedMtimes(root, ['gateway-rs', 'desktop-tauri/src-tauri', 'crates', 'upstream'], sourceEpoch);
}
