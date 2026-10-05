# codeferry-build

This repository builds CodeFerry desktop clients. Product source is checked out from the private repository [crazylin/codeferry](https://github.com/crazylin/codeferry) at build time and is not stored in this public repository.

The private checkout uses that repository's default branch, `main`.

## Actions secret `CODEFERRY_SOURCE_TOKEN`

Store a fine-grained or classic personal access token with `contents:read` on `crazylin/codeferry` as the Actions secret `CODEFERRY_SOURCE_TOKEN`.

This repository does not create or embed that token. When the secret is absent, `.github/workflows/desktop-clients.yml` stops with a missing-secret message before checking out the private source.

```sh
gh secret set CODEFERRY_SOURCE_TOKEN --repo crazylin/codeferry-build
```

The command reads the token from standard input and leaves it out of the repository. After the secret is set, start a build with:

```sh
gh workflow run desktop-clients.yml --repo crazylin/codeferry-build
```

## What the workflow runs

The workflow runs on manual dispatch and on pushes to this repository's default branch, `master`.

- `macos-14`: `CODEFERRY_PACK_PLATFORM=darwin`, `CODEFERRY_PACK_ARCH=arm64`
- `windows-latest`: `CODEFERRY_PACK_PLATFORM=win32`, `CODEFERRY_PACK_ARCH=x64`
- `ubuntu-latest`: `CODEFERRY_PACK_PLATFORM=linux`, `CODEFERRY_PACK_ARCH=x64`

Each job checks that `CODEFERRY_SOURCE_TOKEN` is present, checks out this repository, then checks out `crazylin/codeferry` at `main` with that token and `persist-credentials: false`. It sets up Node.js 22.13.x to match the product engines (`node >= 22.13.0`). In `desktop/` it installs the locked dependencies and runs `npm run package`, which builds the client and executes `desktop/scripts/package.mjs` with those two variables.

The packager keeps each operating system's Runner and CLI with that operating system. A platform with no matching Runner fails closed with `UNSUPPORTED_RUNTIME`. Successful packages are uploaded as workflow artifacts with `overwrite: false`.
