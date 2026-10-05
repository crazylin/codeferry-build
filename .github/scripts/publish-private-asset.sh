#!/usr/bin/env bash
set -euo pipefail
# All assets stay in the private source repository. Concurrent builders may
# share one draft; assets never use --clobber or overwrite an existing filename.
if [ "$#" -ne 2 ] || [ -z "${GH_TOKEN:-}" ] || ! [[ "${SOURCE_SHA:-}" =~ ^[a-f0-9]{40}$ ]]; then
  echo "PRIVATE_RELEASE_ARGUMENT_INVALID" >&2; exit 1
fi
tag="$1"; directory="$2"; repo="crazylin/codeferry"
if ! [[ "${tag}" =~ ^build-[0-9]+-[0-9]+$ ]] || [ ! -d "${directory}" ]; then
  echo "PRIVATE_RELEASE_ARGUMENT_INVALID" >&2; exit 1
fi
if [ "$(gh api "repos/${repo}" --jq '.private')" != 'true' ]; then
  echo "PRIVATE_REPOSITORY_REQUIRED" >&2; exit 1
fi
release="$(gh release view "${tag}" --repo "${repo}" --json isDraft,targetCommitish)"
if [ "$(printf '%s' "$release" | jq -r '.targetCommitish')" != "$SOURCE_SHA" ] || [ "$(printf '%s' "$release" | jq -r '.isDraft')" != true ]; then
  echo "PRIVATE_RELEASE_IDENTITY_INVALID" >&2; exit 1
fi
shopt -s nullglob
files=("${directory}"/*)
if [ "${#files[@]}" -eq 0 ]; then echo "PRIVATE_RELEASE_EMPTY" >&2; exit 1; fi
for file in "${files[@]}"; do
  [ -s "$file" ] && [ -f "$file" ] && [ ! -L "$file" ] || { echo "PRIVATE_RELEASE_ASSET_INVALID" >&2; exit 1; }
done
gh release upload "${tag}" "${files[@]}" --repo "${repo}" >/dev/null
printf '%s\n' 'PRIVATE_RELEASE_ASSETS_UPLOADED'
