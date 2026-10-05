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
