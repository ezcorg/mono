#!/usr/bin/env bash
# What CI checks for the noshorts plugin: formatting, clippy, tests.
set -euo pipefail
cd "$(dirname "$0")/../.."
cargo fmt --package witmproxy-plugin-noshorts --check
cargo clippy --package witmproxy-plugin-noshorts --all-targets -- -D warnings
cargo test --package witmproxy-plugin-noshorts
