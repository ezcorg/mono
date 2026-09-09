#!/usr/bin/env bash
# Builds the witm binary for a target and leaves it at dist/<artifact>. Usage: build-witm.sh <target> <artifact> [version]
set -euo pipefail
cd "$(dirname "$0")/../.."
target=$1 artifact=$2 version=${3:-}
[ -n "$version" ] && src/scripts/set-version.sh src/apps/witmproxy/Cargo.toml "$version"
cargo build --package witmproxy --bin witm --release --target "$target"
mkdir -p dist && cp "target/$target/release/witm" "dist/$artifact"
ls -l "dist/$artifact"
