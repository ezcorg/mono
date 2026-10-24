#!/usr/bin/env bash
# Everything CI checks for witmproxy, runnable at home: formatting and clippy (LINT=0 skips the lint-only steps, which CI
# runs on Linux alone), the signed test plugins, the library tests, the docs, and the binary.
set -euo pipefail
cd "$(dirname "$0")/../.."
LINT=${LINT:-1}
command -v wasmsign2 >/dev/null || cargo install wasmsign2-cli
if [ "$LINT" = 1 ]; then
  cargo fmt --all --check
  cargo clippy --package witmproxy --all-targets -- -D warnings
fi
rm -rf target/wasm32-wasip2   # stale signed plugins would pass the tests for the wrong reasons
make -C src/rust/witmproxy-plugin-noop
make -C src/rust/wasm-test-component
make -C src/rust/witmproxy-plugin-noshorts
# built explicitly so a failure here reads as a build failure, not as a confusing test failure inside the suite
cargo build --release --target wasm32-wasip2 -p witmproxy-plugin-adversarial
cargo test --package witmproxy --lib
if [ "$LINT" = 1 ]; then
  cargo check --package witmproxy --no-default-features   # `otel` is on by default; nothing else exercises it off
  RUSTDOCFLAGS='-D warnings' cargo doc --package witmproxy --no-deps
fi
cargo build --package witmproxy --bin witm
