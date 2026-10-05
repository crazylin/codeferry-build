#!/usr/bin/env bash
# Attach one file to a release on the private source repository.
# The public workflow repository does not store or upload this file.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: publish-private-asset.sh TAG FILE" >&2
  exit 2
fi

tag="$1"
file="$2"
repo="crazylin/codeferry"

if [ -z "${GH_TOKEN:-}" ]; then
  echo "::error::GH_TOKEN is empty."
  exit 1
fi
if [ ! -s "${file}" ]; then
  echo "::error::Build output is missing."
  exit 1
fi

for _ in 1 2 3 4 5 6; do
  if gh release view "${tag}" --repo "${repo}" >/dev/null 2>&1; then
    break
  fi
  gh release create "${tag}" --repo "${repo}" \
    --title "Build ${tag}" \
    --notes "Private build output. Download with: gh release download ${tag} --repo ${repo}" \
    && break
  sleep 2
done

gh release view "${tag}" --repo "${repo}" >/dev/null
gh release upload "${tag}" "${file}" --repo "${repo}" --clobber=false
echo "Uploaded $(basename "${file}") to ${repo} release ${tag}."
