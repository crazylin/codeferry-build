import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expectedMetadata, writeMetadata } from './assets.mjs';
const version = (await readFile('source/gateway-rs/Cargo.toml', 'utf8')).match(/^version\s*=\s*"(\d+\.\d+\.\d+)"/m)?.[1];
const tag = (await readFile(join(process.env.RUNNER_TEMP, 'gateway-tag'), 'utf8')).trim();
await mkdir(process.env.ASSET_DIR, { recursive: true, mode: 0o700 });
const name = `CodeFerry-gateway-${version}-linux-x64.tar.gz`;
const output = join(process.env.ASSET_DIR, name);
// Docker save is streamed through gzip by the workflow. Verify its metadata
// without extracting paths before it is uploaded or accepted for deployment.
const source = resolve('source');
const checker = `import importlib.util,json,pathlib,sys
spec=importlib.util.spec_from_file_location('worker',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
info=json.loads(pathlib.Path(sys.argv[3]).read_text());digest=m.migration_digest(info)
release={'version':sys.argv[4],'source_commit':sys.argv[5]}
assert m.validate_image_archive(pathlib.Path(sys.argv[2]),release,digest)==sys.argv[6]
`;
execFileSync('python3', ['-c', checker, join(source, 'deploy/1panel/release-worker.py'), output,
  join(process.env.RUNNER_TEMP, 'gateway-image/runtime/MIGRATIONS.json'), version, process.env.SOURCE_SHA, tag], { stdio: 'inherit' });
await writeMetadata(output, expectedMetadata('gateway', version, 'linux', 'x64', 'full', name, process.env.SOURCE_SHA));
console.log('GATEWAY_ARCHIVE_IDENTITY_VERIFIED');
