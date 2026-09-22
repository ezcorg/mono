#!/usr/bin/env bash
# Build every wasm32-wasip2 guest the daemon and its tests need, from the
# daemon's current WIT: fetch the WIT deps, build the shipped capabilities,
# refresh the WIT each fixture crate vendors, build the fixtures and install
# their artifacts under host/fixtures/. Run it after changing anything under
# wit/, capabilities/ or host/fixtures/*/; CI runs it before the host tests.
#
#   src/apps/icanhaz/scripts/build-wasm.sh            everything
#   src/apps/icanhaz/scripts/build-wasm.sh --check    fail if a committed fixture artifact changed
set -euo pipefail
cd "$(dirname "$0")/.."
check=0; [ "${1:-}" = "--check" ] && check=1

command -v wkg >/dev/null || { echo "wkg is needed to fetch the WIT deps: cargo install wkg" >&2; exit 1; }
rustup target list --installed | grep -q '^wasm32-wasip2$' || { echo "rustup target add wasm32-wasip2" >&2; exit 1; }

# The daemon's WIT deps (git-ignored, pinned by wkg.lock).
if [ ! -d wit/deps/wasi-filesystem-0.2.12 ]; then wkg wit fetch; fi

# A guest is built on its own (each crate is outside the mono workspace) into
# its own target directory: a global cargo target-dir would take the artifact
# elsewhere. Release, so a fixture's bytes do not depend on the profile.
build() {
  (cd "$1" && cargo build --release --target wasm32-wasip2 --target-dir target --quiet)
}

# The shipped capabilities.
for c in capabilities/*/; do
  echo "== ${c%/}"
  build "$c"
done

# The fixtures, and the example capabilities (authored the way a user would;
# their artifacts land beside the fixtures for the host and browser tests). A
# crate that vendors the daemon's WIT (a `wit/deps/icanhaz-nocap` holding
# nocap.wit) gets a fresh copy first, so it cannot drift from the daemon.
for f in host/fixtures/*/ examples/*/; do
  [ -f "$f/Cargo.toml" ] || continue
  name=$(sed -n 's/^name *= *"\([^"]*\)".*/\1/p' "$f/Cargo.toml" | head -1)
  if [ -f "$f/wit/deps/icanhaz-nocap/nocap.wit" ]; then
    rm -rf "$f/wit/deps/icanhaz-nocap" "$f"/wit/deps/wasi-* "$f"/wit/deps/ezco-ezcap-*
    mkdir -p "$f/wit/deps/icanhaz-nocap"
    cp wit/*.wit "$f/wit/deps/icanhaz-nocap/"
    for d in wit/deps/*/; do
      [ -d "$d" ] || continue
      dep=$(basename "$d")
      mkdir -p "$f/wit/deps/$dep"
      cp "$d"/*.wit "$f/wit/deps/$dep/"
    done
  fi
  echo "== ${f%/} ($name)"
  build "$f"
  artifact="$f/target/wasm32-wasip2/release/${name//-/_}.wasm"
  dest="host/fixtures/${name//-/_}.wasm"
  if [ "$check" = 1 ]; then
    cmp -s "$artifact" "$dest" || { echo "$dest is stale: rebuild with scripts/build-wasm.sh and commit it" >&2; exit 1; }
  else
    cp "$artifact" "$dest"
  fi
done
echo "wasm guests built"
