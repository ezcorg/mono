#!/usr/bin/env bash
# Publishes @joinezco/shared to npm at a version. Usage: publish-shared.sh <version> [--dry-run]
# npm reads the token from NODE_AUTH_TOKEN (with a registry-url configured) or ~/.npmrc.
set -euo pipefail
cd "$(dirname "$0")/../../src/typescript/shared"
npm version "$1" --no-git-tag-version --allow-same-version
pnpm build
if [ "${2:-}" = "--dry-run" ]; then npm publish --access public --dry-run; else npm publish --access public; fi
