# CodeFerry verified builds

This repository contains the public workflow only. Source and release assets stay in the private `crazylin/codeferry` repository. A build resolves one exact private source commit and never switches revisions between tests or platforms. Detailed source build logs stay in private runner files; the existing cleanup workflow removes public run logs afterward.

Failed tasks expose only their exit code, signal and bounded compiler error codes. They do not expose raw source diagnostics, paths or environment values. Successful runs may clear public logs; failed run status and these safe diagnostics remain visible.

Required repository secrets are `CODEFERRY_SOURCE_TOKEN` for private source/assets, `TAURI_SIGNING_PRIVATE_KEY` (and optional `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) for official bundle signing, and `CODEFERRY_PUBLISH_KEY` for the final server publication job. Do not put secrets in source, workflow inputs, command arguments or checked-in files. Only the final publication job receives the server key.

Manual inputs:

| Input | Default | Contract |
| --- | --- | --- |
| `source_commit` | private main resolved once | Optional exact lowercase 40-character commit; all jobs use that SHA |
| `release_scope` | `gateway` | `all` builds the three complete Tauri clients and gateway; `gateway` validates contracts but publishes only the gateway |
| `deploy_gateway` | `true` | Submit deployment once after verified upload, then wait for its terminal status |

The first workflow push uses `all`. Gateway-only dispatch is useful after that initial release. New gateway releases require increasing Cargo version; delivered desktop updates require increasing desktop version. Existing versioned artifacts are immutable. On a failed or unknown upload/deploy, inspect the existing release and deployment first. A rebuild with different bytes requires a new version; there is no overwrite or automatic effectful replay.

New desktop releases use Tauri 2/Rust/system WebViews only. Mac arm64 builds produce dmg and signed app.tar.gz, Windows x64 produces signed NSIS exe, and Linux x64 produces deb and signed AppImage. Node is a build dependency, not a shipped runtime. No Electron/runtime/slim build or legacy migration path is published. Official updater signatures are independently streamed and verified together with their signed version at collection and final publication. The five client artifacts and one gateway artifact must form the exact expected immutable set. Signing secrets are absent from the gateway job and server publisher. Platform build success is distinct from real website login and actual installer/update acceptance.

The validation gate installs only the current `desktop-tauri` frontend dependencies and runs its typecheck and production build. The shared React renderer resolves types and runtime from that dependency tree; a clean checkout needs no retired Electron dependency tree or runtime manifests. Each independent platform checkout builds its own frontend assets before testing the Rust client with its actual shipped Runner and packaging. macOS packages the app first and creates its sealed updater and DMG without Finder automation.

Build caching has two separate stores. `setup-node` caches only the public npm registry downloads identified by the two exact package lockfiles; it does not cache `node_modules`, the private checkout or compiled applications. Cargo targets contain private binaries and debug information, so they never use public `actions/cache`. Their bounded archives and manifests are stored as immutable draft releases in the private `crazylin/codeferry` repository, under `cargo-cache-v1-…` tags distinct from build/release and diagnostic tags. Restore and save steps receive the source token only in their environment; signing and server publication keys are not available to cache helpers.

Rust caches are partitioned by validation, gateway, and desktop OS/architecture, then separately by native/gateway/desktop target and debug/release profile. Per-part keys include Rust 1.96.0 identity, runner OS/image version, reviewed native baseline/patch and native Cargo lock/manifest hashes, relevant gateway or desktop Cargo lock/manifest hashes, compile flags and cache schema. Only the local codeferry-desktop package version is normalized in the desktop manifest and its single local lockfile entry, so a delivery version bump reuses compatible dependencies; every dependency version, checksum, source and feature remains part of the key. Ambiguous formats become a cache miss. Cargo still rebuilds the changed application. Compatible native and gateway parts retain their independent keys. Ordinary application source edits reuse the dependency cache; relevant dependency/native patch/toolchain changes invalidate it. CI disables dev/test debug symbol output and incremental compilation to reduce memory, link time and cache size; test execution/debug assertions and shipped release profiles remain unchanged. Those flags are part of each cache identity. Each archive keeps only `deps`, `build` and `.fingerprint`; incremental trees, final/test executables, dSYM/PDB bundles, installers, signatures and private key outputs are excluded. Each profile has its own size budget, so one large target does not discard the other usable caches.

Each cache part is limited to 1.75 GiB compressed, 12 GiB expanded and 100,000 entries. Restore verifies exact manifest identity, archive SHA-256 and bounded regular-file paths before moving a validated target profile into a fresh checkout; absolute paths, traversal, symlinks, duplicate paths, special files and oversized tar metadata are refused. Existing target profiles and immutable cache tags are never overwritten. Each exact dependency key/profile has at most two immutable generations: available compilation from a failed/diagnostic job forms `partial`; a successful full job may add its separate `complete` generation. Restore prefers complete, then partial. This allows successful builds to improve an earlier partial cache without repeated per-run uploads or changing previous bytes. Cache absence, corruption, capacity limits or uncertain cache creation/upload remain a safe miss and the product build continues. Available compiled dependencies are saved after failed builds as well, except cancellation, so another attempt can reuse successful earlier compilation. A cache hit still runs every Cargo check/test, native identity verification, signing and package/publication gate. Real two-checkout Cargo fixtures demonstrate a cached dependency remains `Fresh`; a first cold platform build still has to compile it.

Failed validation, desktop or gateway tasks retain only bounded, allowlisted pre-signing diagnostics in separate private diagnostic drafts. Signing, bundle-finalization and publication logs are excluded. These diagnostic drafts are not part of the six-artifact publisher input, and failure remains visible without exposing source or credentials in public logs.

For a shorter manual desktop compile/browser diagnosis, run `gh workflow run desktop-diagnostics.yml -f source_commit=<exact-40-character-source-SHA>`. This lane compiles client test executables and runs nonignored tests without the actual Runner integration lane, exercises the real macOS native browser fixture, and primes partial private dependency caches. It has no signing or server publication authority. Passing it is compile/browser evidence; the full release lane still runs the authoritative Runner, complete tests, packaging and publication gates.

Gateway images contain the embedded gateway executable, public assets, canonical SQLx migration identity and all dependency notices. Docker startup and graceful native shutdown run against isolated PostgreSQL/Redis fixtures before publication. The server's separate host worker validates immutable image labels and exact current migration checksums before automatic replacement; it preserves existing data.

Before creating immutable release metadata, the producer canonicalizes its job-local Docker archive. It verifies the exact single-image OCI graph and prunes only recognized, validated Docker V1 compatibility metadata. Conflicting tags, additional image graphs, unrecognized files and digest mismatches fail without rewriting the input. The unchanged production inspector verifies the resulting archive before upload; published artifacts are never rewritten.

For local cross-compilation without Docker, stage from a fresh private source alias:

```sh
SOURCE_SHA=<exact-committed-source-sha> \
RUNNER_TEMP=<fresh-existing-private-staging-directory> \
GATEWAY_BINARY=<source/gateway-rs/target/linux-target/release/codeferry-gateway> \
node .github/scripts/gateway-image.mjs --stage-only
```

The current working directory must contain `source/` (a source alias is allowed locally). The binary must be a regular Linux amd64 ELF beneath that source's `gateway-rs/target`; no internal symlink is accepted. `gateway-image/build-info.json` contains version, source SHA, migration digest and image tag. Upload the prepared context and build with those exact args, `--platform linux/amd64 --provenance=false --sbom=false`; then perform actual image/identity/startup/drain and updater archive checks. Stage-only does not certify deployment or label dirty source as a reviewed release.

Local workflow contracts:

```sh
node --test .github/scripts/tests/*.test.mjs
actionlint -shellcheck= -pyflakes= .github/workflows/*.yml
```
