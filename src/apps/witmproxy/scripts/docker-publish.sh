#!/usr/bin/env bash
# Build and push the witmproxy Docker image to ghcr.io/ezcorg/witmproxy.
#
# Usage:
#   ./scripts/docker-publish.sh                       # native arch, tagged :latest + :sha-<short>
#   ./scripts/docker-publish.sh v0.0.1                # also tag :v0.0.1
#   PLATFORMS=linux/amd64,linux/arm64 ./scripts/docker-publish.sh   # multi-arch
#   PUSH=0 ./scripts/docker-publish.sh                # build only, do not push
#
# Requires: docker (with buildx), gh CLI authenticated, git.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

IMAGE="ghcr.io/ezcorg/witmproxy"
PLATFORMS="${PLATFORMS:-linux/$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')}"
PUSH="${PUSH:-1}"

cd "$REPO_ROOT"

SHA="$(git rev-parse --short HEAD)"
TAGS=(--tag "$IMAGE:latest" --tag "$IMAGE:sha-$SHA")
for extra in "$@"; do
    TAGS+=(--tag "$IMAGE:$extra")
done

if [ "$PUSH" = "1" ]; then
    DOCKER_CONFIG_DIR="${DOCKER_CONFIG:-$HOME/.docker}"
    if grep -q '"ghcr.io"' "$DOCKER_CONFIG_DIR/config.json" 2>/dev/null; then
        echo "Reusing existing ghcr.io login from $DOCKER_CONFIG_DIR/config.json"
    else
        echo "Logging in to ghcr.io via gh CLI..."
        gh auth token | docker login ghcr.io \
            -u "$(gh api user -q .login)" \
            --password-stdin
    fi
    OUTPUT=(--push)
else
    OUTPUT=(--load)
fi

echo "Building $IMAGE for $PLATFORMS"
echo "Tags: ${TAGS[*]}"

docker buildx build \
    --platform "$PLATFORMS" \
    "${TAGS[@]}" \
    --file src/apps/witmproxy/Dockerfile \
    "${OUTPUT[@]}" \
    .
