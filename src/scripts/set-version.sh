#!/usr/bin/env bash
# Sets the `version = "…"` line of a Cargo.toml. Usage: set-version.sh <Cargo.toml> <version>
set -euo pipefail
sed -i.bak -e "s/^version = \".*\"/version = \"$2\"/" "$1" && rm -f "$1.bak"
grep -E '^version' "$1"
