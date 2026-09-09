#!/usr/bin/env bash
# A bidiff patch from the previous witmproxy release's binary to this one's, at dist/<artifact>.bidiff-from-<prev>.
# Usage: patch-witm.sh <version> <artifact>   (needs gh, signed in; prints the patch path, or nothing if there is no previous release)
set -euo pipefail
cd "$(dirname "$0")/../.."
version=$1 artifact=$2 repo=${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}
command -v bidiff >/dev/null || cargo install bidiff >&2
prev=$(git tag --list 'witmproxy-v*' --sort=-version:refname | grep -v "^witmproxy-v$version\$" | head -1)
[ -n "$prev" ] || { echo "no previous release tag" >&2; exit 0; }
mkdir -p dist/current dist/previous
gh release download "witmproxy-v$version" --pattern "$artifact" --dir dist/current --repo "$repo" --clobber >&2
gh release download "$prev" --pattern "$artifact" --dir dist/previous --repo "$repo" --clobber >&2 || { echo "$prev has no $artifact" >&2; exit 0; }
patch="dist/$artifact.bidiff-from-${prev#witmproxy-v}"
bidiff "dist/previous/$artifact" "dist/current/$artifact" "$patch" >&2
echo "$patch"
