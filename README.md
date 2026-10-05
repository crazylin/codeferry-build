# codeferry-build

This public repository only compiles CodeFerry. It does not contain product source, and it does not publish build outputs.

The workflow checks out the private repository [crazylin/codeferry](https://github.com/crazylin/codeferry) at `main` when a run starts. Finished desktop clients and the gateway image are uploaded to a release on that private repository. They are not Actions artifacts of this public repository, so they cannot be downloaded from here.

## Secret

Store one personal access token as the Actions secret `CODEFERRY_SOURCE_TOKEN`.

The token needs `contents:read` and `contents:write` on `crazylin/codeferry`. Read is used to check out the source. Write is used only to attach the finished files to a private release. This repository does not create or embed the token.

```sh
gh secret set CODEFERRY_SOURCE_TOKEN --repo crazylin/codeferry-build
```

The command reads the token from standard input.

After the secret is set:

```sh
gh workflow run desktop-clients.yml --repo crazylin/codeferry-build
```

## What a run compiles

Manual dispatch, and pushes to `master`, start:

- macOS 14 arm64, Windows x64, and Linux x64 desktop clients
- a Linux amd64 gateway image that includes the compiled gateway and native Server

A platform with no matching Runner or CLI stops with `UNSUPPORTED_RUNTIME` and does not package another platform's binary.

## Download

Each run uses a new release tag, `build-<run id>-<attempt>`, on the private repository. Download it with an account that can read that repository, then upload the files to the server yourself:

```sh
gh release download build-RUN_ID-ATTEMPT --repo crazylin/codeferry
gunzip -c codeferry-gateway-build-RUN_ID-ATTEMPT.tar.gz | docker load
```

Loading the image does not replace the running server. Point Compose at the loaded tag only after you have checked it.
