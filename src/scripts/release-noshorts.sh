#!/usr/bin/env bash
# Builds and signs the noshorts plugin at a version; the release files land in dist/. Usage: release-noshorts.sh <version>
set -euo pipefail
cd "$(dirname "$0")/../.."
src/scripts/set-version.sh src/rust/witmproxy-plugin-noshorts/Cargo.toml "$1"
make -C src/rust/witmproxy-plugin-noshorts
mkdir -p dist
cp target/wasm32-wasip2/release/witmproxy_plugin_noshorts.signed.wasm "dist/witmproxy-plugin-noshorts-v$1.wasm"
cp src/rust/witmproxy-plugin-noshorts/key.public "dist/witmproxy-plugin-noshorts-v$1.key.public"
ls -l dist/witmproxy-plugin-noshorts-v"$1".*
