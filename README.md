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

For manual desktop diagnosis, run `gh workflow run desktop-diagnostics.yml -f source_commit=<exact-40-character-source-SHA>`. On each selected platform this lane reproduces the native patch, builds the exact Server/Runner in the release profile through the source's authoritative identity checks, compiles client test executables, and runs nonignored client tests. It also explicitly runs the controlled actual shared-Runner tests: Windows must execute the shared project retirement/reopen test; macOS/Linux must execute all eight required shared-Runner tests, including disconnect/no-replay, ordinary/persistent crash cleanup, guard I/O and persistent timeout synchronization. The separate disconnect test currently has a Unix-only fixture and is not claimed as Windows evidence. Cargo success with zero tests, ignored tests, missing required test names or a failed report is refused. The macOS native browser fixture and partial private dependency cache remain enabled; the total job budget remains 90 minutes. Raw native build and acceptance diagnostics use the existing private redacted-log path. This workflow creates no formal desktop ZIP or installer and does not sign, deploy or publish a product release. Passing it is source compilation and controlled runtime evidence; the full release lane still runs complete tests, packaging, signing and publication gates.

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

## Backend acceptance without publication

The manual preflight also accepts `platform=backend` on the backend feature branch. It runs only the Ubuntu backend job; the existing `all` and `win32` choices keep their desktop behavior. Select an exact source commit that includes `scripts/backend-acceptance.mjs`:

```sh
gh workflow run desktop-diagnostics.yml --repo crazylin/codeferry-build \
  --ref codex/backend-preflight-2026-10-14 \
  -f source_commit=<exact-40-character-source-SHA> -f platform=backend
```

This lane owns fresh digest-pinned PostgreSQL and Redis containers with loopback fixture URLs. PostgreSQL uses the explicitly disposable `codeferry_test` database; Redis uses database 0 on the job's fresh service. It checks the source identity, reproduces the upstream patch, builds TypeScript, runs source contracts and invokes the source's bounded backend acceptance helper. The helper must reject absent fixture configuration, nonexecuted database tests and missing required named results. Raw diagnostics and Rust dependency caches remain in private source drafts. The job has a 120-minute budget; it receives no product signing or publisher keys and never runs release or server replacement jobs. Passing it is actual disposable-service evidence, not validation of production data, a deployed server or provider OAuth.

## Mac shared Runner Gateway acceptance without publication

Select `platform=native-e2e` on the same feature branch to run the Mac ARM acceptance alone:

```sh
gh workflow run desktop-diagnostics.yml --repo crazylin/codeferry-build \
  --ref codex/backend-preflight-2026-10-14 \
  -f source_commit=<exact-40-character-source-SHA> -f platform=native-e2e
```

The job checks the exact private source revision and ARM architecture, installs locked Node dependencies, reproduces the native patch, builds the verified release Runner and real embedded Gateway, then calls `source/scripts/native-gateway-acceptance.mjs`. That source helper compiles the test-only controller for the production Rust `RunnerSupervisor`, starts an isolated PostgreSQL fixture, and requires the real Gateway integration suite to execute. The suite owns its temporary Redis and embedded native Server. Test accounts and private Runner credentials belong to this isolated run; production environment files, signing and publication credentials are absent. Two projects must share one account/device Runner. Closed temporary links are checked as disabled.

Fixture dependencies are fixed at PostgreSQL **16.15** and Redis **8.10.2**. The fixture preparation helper reuses installed tools only when every required binary reports the exact version. Otherwise it builds the official [PostgreSQL archive](https://ftp.postgresql.org/pub/source/v16.15/postgresql-16.15.tar.bz2) and [Redis archive](https://download.redis.io/releases/redis-8.10.2.tar.gz) after checking their fixed SHA-256 values. It installs only beneath the job's private temporary directory, with cleared credential and compiler override variables, and never starts system/Homebrew services. The identity record distinguishes exact installed versions from verified archive builds; installed binaries are not claimed to be byte-identical to the archive build.

Native/desktop and Mac Gateway debug dependency caches remain separate private immutable drafts. They retain their existing exact source, lockfile, platform, toolchain, image and profile checks. Raw compilation and acceptance diagnostics use the private bounded collector. The `all` and `win32` choices keep their existing desktop behavior. This 120-minute lane produces no signed installer, product ZIP, deployment or release; it does not certify real provider OAuth, official account login, reboot behavior or other platforms.

Local workflow contracts:

```sh
node --test .github/scripts/tests/*.test.mjs
actionlint -shellcheck= -pyflakes= .github/workflows/*.yml
```
