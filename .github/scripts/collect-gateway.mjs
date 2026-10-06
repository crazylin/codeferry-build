import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedMetadata, writeMetadata } from './assets.mjs';
const version = (await readFile('source/gateway-rs/Cargo.toml', 'utf8')).match(/^version\s*=\s*"(\d+\.\d+\.\d+)"/m)?.[1];
const tag = (await readFile(join(process.env.RUNNER_TEMP, 'gateway-tag'), 'utf8')).trim();
await mkdir(process.env.ASSET_DIR, { recursive: true, mode: 0o700 });
const name = `CodeFerry-gateway-${version}-linux-x64.tar.gz`;
const output = join(process.env.ASSET_DIR, name);
// Docker save is streamed through gzip by the workflow. Verify its metadata
// without extracting paths before it is uploaded or accepted for deployment.
const source = resolve('source');
// Docker's exporter also emits obsolete V1 metadata. Canonicalize only the
// unpublished job-local archive; the unchanged production inspector verifies
// the exact one-image bytes before immutable metadata is created.
execFileSync('python3', [fileURLToPath(new URL('./canonical-gateway-archive.py', import.meta.url)), join(source, 'deploy/1panel/release-worker.py'), output,
  join(process.env.RUNNER_TEMP, 'gateway-image/runtime/MIGRATIONS.json'), version, process.env.SOURCE_SHA, tag], { stdio: 'inherit' });
await writeMetadata(output, expectedMetadata('gateway', version, 'linux', 'x64', 'full', name, process.env.SOURCE_SHA));
console.log('GATEWAY_ARCHIVE_IDENTITY_VERIFIED');
