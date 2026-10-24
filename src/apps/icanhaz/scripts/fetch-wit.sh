#!/usr/bin/env bash
# The daemon's WIT deps, fetched when missing: wit/deps is git-ignored and
# pinned by wkg.lock (the wasi:* packages from the registry; ezco:ezcap copied
# from src/rust/ezcap/wit by wkg.toml's override). The broker's build script
# resolves wit/ with them, so they come before any build of icanhaz-broker:
# the host, the guests (build-wasm.sh), and witmproxy (check-witmproxy.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -d wit/deps/wasi-filesystem-0.2.12 ] || [ ! -d wit/deps/ezco-ezcap-0.1.0 ]; then
  command -v wkg >/dev/null || cargo install wkg --locked
  wkg wit fetch
fi
