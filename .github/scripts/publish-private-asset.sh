#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: publish-private-asset.sh TAG FILE" >&2
  exit 2
fi

tag="$1"
file="$2"
repo="crazylin/codeferry"

if [ -z "${GH_TOKEN:-}" ]; then
  echo "::error::MISSING_GH_TOKEN"
  exit 1
fi
if [ ! -s "${file}" ]; then
  echo "::error::MISSING_BUILD_OUTPUT"
  exit 1
fi

for _ in 1 2 3 4 5 6; do
  if gh release view "${tag}" --repo "${repo}" >/dev/null 2>&1; then
    break
  fi
  gh release create "${tag}" --repo "${repo}" \
    --title "Build ${tag}" \
    --notes "" \
    && break
  sleep 2
done

gh release view "${tag}" --repo "${repo}" >/dev/null
gh release upload "${tag}" "${file}" --repo "${repo}" --clobber=false
