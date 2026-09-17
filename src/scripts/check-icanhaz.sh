#!/usr/bin/env bash
# Everything CI checks for icanhaz, runnable at home: formatting and clippy (LINT=0 skips
# the lint-only steps), the wasm guests (the shipped capabilities and the test fixtures,
# rebuilt from the daemon's WIT), and the host and broker tests. The browser suite is not
# here: it needs a browser, rust-analyzer and a login shell, and runs from web/ by hand.
set -euo pipefail
cd "$(dirname "$0")/../.."
LINT=${LINT:-1}
if [ "$LINT" = 1 ]; then
  cargo fmt --package icanhaz-host --package icanhaz-broker --package ezcap --check
  cargo clippy --package icanhaz-host --package icanhaz-broker --package ezcap --all-targets -- -D warnings
fi
src/apps/icanhaz/scripts/build-wasm.sh
cargo test --package icanhaz-host --package icanhaz-broker --package ezcap --lib
