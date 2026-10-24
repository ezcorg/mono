#!/usr/bin/env bash
# Publishes witmproxy to crates.io at a version. Usage: release-witmproxy.sh <version> [--dry-run]
# cargo reads the token from CARGO_REGISTRY_TOKEN.
set -euo pipefail
cd "$(dirname "$0")/../.."
src/scripts/set-version.sh src/apps/witmproxy/Cargo.toml "$1"
cd src/apps/witmproxy
cargo build --release
cargo package --list
if [ "${2:-}" = "--dry-run" ]; then cargo publish --dry-run; else cargo publish; fi
