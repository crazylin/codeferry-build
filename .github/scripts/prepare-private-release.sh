#!/usr/bin/env bash
set -euo pipefail
repo='crazylin/codeferry'; tag="build-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
if [ -z "${GH_TOKEN:-}" ] || ! [[ "${SOURCE_SHA:-}" =~ ^[a-f0-9]{40}$ ]] || ! [[ "$tag" =~ ^build-[0-9]+-[0-9]+$ ]]; then
  echo 'PRIVATE_RELEASE_ARGUMENT_INVALID' >&2; exit 1
fi
if [ "$(gh api "repos/${repo}" --jq '.private')" != true ]; then echo 'PRIVATE_REPOSITORY_REQUIRED' >&2; exit 1; fi
if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
  echo 'PRIVATE_RELEASE_ALREADY_EXISTS' >&2; exit 1
fi
# A single job owns creation. Never retry a possibly successful creation.
gh release create "$tag" --repo "$repo" --target "$SOURCE_SHA" --draft --title "Build ${tag}" --notes '' >/dev/null
release="$(gh release view "$tag" --repo "$repo" --json isDraft,targetCommitish)"
if [ "$(printf '%s' "$release" | jq -r '.isDraft')" != true ] || [ "$(printf '%s' "$release" | jq -r '.targetCommitish')" != "$SOURCE_SHA" ]; then
  echo 'PRIVATE_RELEASE_IDENTITY_INVALID' >&2; exit 1
fi
printf '%s\n' 'PRIVATE_BUILD_RELEASE_CREATED'
