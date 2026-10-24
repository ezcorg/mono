#!/usr/bin/env bash
# Builds the witm binary for a target and leaves it at dist/<artifact>. Usage: build-witm.sh <target> <artifact> [version]
set -euo pipefail
cd "$(dirname "$0")/../.."
target=$1 artifact=$2 version=${3:-}
[ -n "$version" ] && src/scripts/set-version.sh src/apps/witmproxy/Cargo.toml "$version"
if [ "${ZIGBUILD:-0}" = 1 ]; then
  # On a NixOS runner a plain cargo build links against the Nix store's glibc.
  # zig as the linker targets glibc 2.28 instead, so the binary runs anywhere.
  cargo zigbuild --package witmproxy --bin witm --release --target "$target.2.28"
else
  cargo build --package witmproxy --bin witm --release --target "$target"
fi
mkdir -p dist && cp "target/$target/release/witm" "dist/$artifact"
ls -l "dist/$artifact"
