/** Stage reviewed runtime bytes and migration/license identity; Docker is optional. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, cp, copyFile, readdir, readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = path => !!path && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);

export async function resolveGatewayBinary(sourceRoot, input) {
  const originalSource = resolve(sourceRoot); const source = await realpath(originalSource);
  const target = join(source, 'gateway-rs', 'target');
  if (!(await lstat(target)).isDirectory()) throw Error('GATEWAY_BINARY_TARGET_INVALID');
  if (input !== undefined && (typeof input !== 'string' || input.length > 4096 || /[\x00-\x1f]/.test(input))) throw Error('GATEWAY_BINARY_INVALID');
  const binary = input ? resolve(input) : join(target, 'release', 'codeferry-gateway');
  // A local stage-only source alias may be a symlink. Every path beneath its
  // canonical target directory must be regular; aliases inside target fail.
  let rel = relative(target, binary);
  if (!inside(rel)) rel = relative(join(originalSource, 'gateway-rs', 'target'), binary);
  if (!inside(rel)) throw Error('GATEWAY_BINARY_OUTSIDE_TARGET');
  let cursor = target;
  for (const part of rel.split(sep)) {
    cursor = join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw Error('GATEWAY_BINARY_SYMLINK');
  }
  const info = await lstat(cursor);
  if (!info.isFile() || info.size < 64 || info.size > 128 * 1024 ** 2) throw Error('GATEWAY_BINARY_INVALID');
  const bytes = await readFile(cursor);
  if (bytes.length !== info.size || !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 62) throw Error('GATEWAY_BINARY_REQUIRES_LINUX_AMD64_ELF');
  return { path: cursor, sha256: digest(bytes), size: bytes.length };
}

async function collectLegal(directory, output, legal = false, depth = 0) {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && (legal || /^(license|licence|copying|notice|copyright)([._-]|$)/i.test(entry.name))) {
      const input = join(directory, entry.name); if ((await lstat(input)).size > 2 * 1024 ** 2) throw Error('GATEWAY_LICENSE_TOO_LARGE');
      await mkdir(output, { recursive: true }); await copyFile(input, join(output, entry.name)); count++;
    } else if (entry.isDirectory() && depth < 2 && /^(licenses?|legal|third[._-]?party)$/i.test(entry.name)) {
      count += await collectLegal(join(directory, entry.name), join(output, entry.name), true, depth + 1);
    }
  }
  return count;
}

async function reviewedLicense(pkg, output) {
  const legalRoot = resolve(here, '../licenses');
  const rows = JSON.parse(await readFile(join(legalRoot, 'manifest.json'), 'utf8'));
  const row = rows.find(row => row.version === pkg.version && (row.family === pkg.name || row.family === 'salvo' && /^salvo(?:[_-]|$)/.test(pkg.name)));
  if (!row) return false;
  const vcs = JSON.parse(await readFile(join(dirname(pkg.manifest_path), '.cargo_vcs_info.json'), 'utf8'));
  if (pkg.repository?.replace(/\.git$/, '') !== row.repository || vcs.git?.sha1 !== row.commit || !/^[A-Za-z0-9_.-]+$/.test(row.file)) throw Error('GATEWAY_REVIEWED_LICENSE_SOURCE_MISMATCH');
  const bytes = await readFile(join(legalRoot, row.file));
  if (digest(bytes) !== row.sha256) throw Error('GATEWAY_REVIEWED_LICENSE_HASH_MISMATCH');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'REVIEWED_UPSTREAM_LICENSE'), bytes, { flag: 'wx' });
  await writeFile(join(output, 'SOURCE.json'), JSON.stringify(row, null, 2) + '\n', { flag: 'wx' });
  return true;
}

export async function stageGatewayImage({ sourceRoot = resolve('source'), temporaryRoot = process.env.RUNNER_TEMP,
  sourceSha = process.env.SOURCE_SHA, binaryInput = process.env.GATEWAY_BINARY, stageOnly = false } = {}) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? '') || !temporaryRoot) throw Error('GATEWAY_IMAGE_SOURCE_INVALID');
  const source = await realpath(sourceRoot); const context = join(await realpath(temporaryRoot), 'gateway-image');
  const runtime = join(context, 'runtime');
  const toml = await readFile(join(source, 'gateway-rs/Cargo.toml'), 'utf8');
  const version = toml.match(/^version\s*=\s*"((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))"/m)?.[1];
  if (!version) throw Error('GATEWAY_IMAGE_VERSION_INVALID');
  const binary = await resolveGatewayBinary(sourceRoot, binaryInput);
  await mkdir(context); await mkdir(runtime);
  await copyFile(binary.path, join(runtime, 'codeferry-gateway'));
  if (digest(await readFile(join(runtime, 'codeferry-gateway'))) !== binary.sha256) throw Error('GATEWAY_BINARY_CHANGED');
  await cp(join(source, 'public'), join(runtime, 'public'), { recursive: true });
  await copyFile(join(source, 'gateway-rs/LICENSE'), join(runtime, 'LICENSE'));
  await copyFile(join(source, 'upstream/webcodex/LICENSE'), join(runtime, 'WEBCODEX_LICENSE'));
  await copyFile(join(source, 'desktop/NOTICE.md'), join(runtime, 'CODEFERRY-NOTICE.md'));
  await copyFile(join(source, 'deploy/1panel/Dockerfile'), join(context, 'Dockerfile'));
  const cert = process.platform === 'darwin' ? '/etc/ssl/cert.pem' : '/etc/ssl/certs/ca-certificates.crt';
  await copyFile(cert, join(context, 'ca-certificates.crt'));
  const migrationHash = execFileSync('python3', [join(source, 'scripts/release-image-info.py'),
    '--migrations', join(source, 'gateway-rs/migrations'), '--output', join(runtime, 'MIGRATIONS.json')], { encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{64}$/.test(migrationHash)) throw Error('GATEWAY_IMAGE_MIGRATIONS_INVALID');
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--manifest-path', join(source, 'gateway-rs/Cargo.toml'),
    '--locked', '--offline', '--filter-platform', 'x86_64-unknown-linux-gnu', '--format-version', '1'], { encoding: 'utf8', maxBuffer: 32 * 1024 ** 2 }));
  const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node])); const included = new Set();
  function include(id) { if (included.has(id)) return; included.add(id); for (const dep of nodes.get(id)?.deps ?? []) if (dep.dep_kinds.some(kind => kind.kind !== 'dev')) include(dep.pkg); }
  include(metadata.resolve.root);
  const inventory = [];
  for (const pkg of metadata.packages.filter(pkg => included.has(pkg.id)).sort((a,b) => a.id.localeCompare(b.id))) {
    const directory = join(runtime, 'licenses', 'cargo-' + pkg.name + '-' + pkg.version.replace(/[^a-zA-Z0-9_.-]/g, '_'));
    let count = await collectLegal(dirname(pkg.manifest_path), directory);
    if (pkg.license_file) {
      const declared = resolve(dirname(pkg.manifest_path), pkg.license_file); const info = await lstat(declared);
      if (!info.isFile() || info.size > 2 * 1024 ** 2) throw Error('GATEWAY_DEPENDENCY_LICENSE_INVALID');
      await mkdir(directory, { recursive: true }); await copyFile(declared, join(directory, 'DECLARED_LICENSE')); count++;
    }
    if (!count && !pkg.source) { await mkdir(directory, { recursive: true }); await copyFile(join(source, pkg.name === 'codeferry-gateway' ? 'gateway-rs/LICENSE' : 'upstream/webcodex/LICENSE'), join(directory, 'LICENSE')); count++; }
    if (!count && await reviewedLicense(pkg, directory)) count++;
    if (!count || (!pkg.license && !pkg.license_file)) throw Error('GATEWAY_DEPENDENCY_LICENSE_MISSING');
    inventory.push({ name: pkg.name, version: pkg.version, license: pkg.license ?? 'See declared license file',
      source: pkg.source ? `https://crates.io/crates/${pkg.name}/${pkg.version}` : 'CodeFerry reviewed native source', noticeDirectory: 'licenses/' + directory.split(/[\\/]/).pop() });
  }
  await writeFile(join(runtime, 'dependencies.json'), JSON.stringify({ packages: inventory }, null, 2) + '\n', { flag: 'wx' });
  await writeFile(join(runtime, 'THIRD_PARTY_NOTICES.md'), '# CodeFerry embedded Rust gateway\n\nWebCodex retains Apache-2.0 attribution and its upstream license. Exact locked normal/build dependencies and local license texts are in dependencies.json and licenses/. Reviewed upstream notices include immutable source provenance and hashes. The image also retains Debian distribution notices. No separate native Server executable is bundled.\n', { flag: 'wx' });
  const tag = `codeferry-gateway:${version}-${sourceSha.slice(0,12)}`;
  const info = { product: 'CodeFerry', version, sourceSha, migrationsSha256: migrationHash, tag,
    platform: 'linux/amd64', binarySha256: binary.sha256, binarySize: binary.size, dependencyPackages: inventory.length };
  await writeFile(join(context, 'build-info.json'), JSON.stringify(info, null, 2) + '\n', { flag: 'wx' });
  if (!stageOnly) {
    execFileSync('docker', ['build', '--platform', 'linux/amd64', '--provenance=false', '--sbom=false', '--build-arg', 'VERSION=' + version,
      '--build-arg', 'SOURCE_SHA=' + sourceSha, '--build-arg', 'MIGRATIONS_SHA256=' + migrationHash, '-t', tag, context], { stdio: 'inherit' });
    const image = JSON.parse(execFileSync('docker', ['image', 'inspect', tag], { encoding: 'utf8' }))[0];
    if (image.Architecture !== 'amd64' || image.Os !== 'linux' || image.Config.Labels['io.codeferry.product'] !== 'CodeFerry' ||
      image.Config.Labels['org.opencontainers.image.version'] !== version || image.Config.Labels['org.opencontainers.image.revision'] !== sourceSha ||
      image.Config.Labels['io.codeferry.migrations'] !== migrationHash || image.Config.User !== '10001:10001' ||
      JSON.stringify(image.Config.Entrypoint) !== JSON.stringify(['/app/codeferry-gateway'])) throw Error('GATEWAY_IMAGE_IDENTITY_INVALID');
  }
  await writeFile(join(temporaryRoot, 'gateway-tag'), tag, { flag: 'wx' });
  return { context, ...info };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.length === 1 && args[0] !== '--stage-only') throw Error('GATEWAY_IMAGE_ARGUMENT_INVALID');
  await stageGatewayImage({ stageOnly: args[0] === '--stage-only' });
  console.log(args[0] === '--stage-only' ? 'GATEWAY_IMAGE_CONTEXT_STAGED_NO_DOCKER' : 'GATEWAY_IMAGE_STAGED_AND_VERIFIED');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(/^GATEWAY_[A-Z0-9_]+$/.test(error.message) ? error.message : 'GATEWAY_IMAGE_PREPARATION_FAILED'); process.exitCode = 1;
});
