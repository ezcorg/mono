#!/usr/bin/env bash
# Builds the witm binary for a target and leaves it at dist/<artifact>. Usage: build-witm.sh <target> <artifact> [version]
# ZIGBUILD=1 (Linux, on a Nix host) links with zig against glibc 2.28, for a binary that runs anywhere.
set -euo pipefail
cd "$(dirname "$0")/../.."
target=$1 artifact=$2 version=${3:-}
[ -n "$version" ] && src/scripts/set-version.sh src/apps/witmproxy/Cargo.toml "$version"
if [ "${ZIGBUILD:-0}" = 1 ]; then
  # On a NixOS runner a plain cargo build links against the Nix store's glibc.
  # zig as the linker targets glibc 2.28 instead, so the binary runs anywhere.
  glibc=2.28
  # cel-cpp (cel-cxx-ffi's build script) is built by Bazel, which takes its compiler
  # from CC, not from the CC_<target> cargo-zigbuild sets. Left alone it uses the Nix
  # GCC, and zig cannot link what that produces: zig has libc++, not libstdc++, and
  # glibc 2.28 here. So Bazel compiles with zig too, through cargo-zigbuild's proxy
  # (its own zig, its usual argument fixes); `zig c++`, so C++ sources find libc++.
  zig_cache=${XDG_CACHE_HOME:-$HOME/.cache}/zig
  zigdir=$PWD/target/zigbuild
  mkdir -p "$zigdir" "$zig_cache"
  cat > "$zigdir/cc" <<EOF
#!/bin/sh
# zig as Bazel's C/C++ compiler, written by src/scripts/build-witm.sh
export ZIG_GLOBAL_CACHE_DIR=$zig_cache
exec $(command -v cargo-zigbuild) zig c++ -- -target ${target/-unknown-/-}.$glibc "\$@"
EOF
  chmod +x "$zigdir/cc"
  # Bazel sandboxes its actions with a scrubbed environment: zig's cache (the libc++
  # and glibc stubs it builds) has to be writable in there. The layering check is a
  # lint; off, as on macOS. Bazel takes options from rc files only, so ~/.bazelrc
  # imports this one (try-import: no complaint once target/ is gone).
  cat > "$zigdir/bazelrc" <<EOF
build --sandbox_writable_path=$zig_cache
build --features=-layering_check --host_features=-layering_check
EOF
  grep -qxF "try-import $zigdir/bazelrc" ~/.bazelrc 2>/dev/null || echo "try-import $zigdir/bazelrc" >> ~/.bazelrc
  export CC=$zigdir/cc
  cargo zigbuild --package witmproxy --bin witm --release --target "$target.$glibc"
else
  cargo build --package witmproxy --bin witm --release --target "$target"
fi
mkdir -p dist && cp "target/$target/release/witm" "dist/$artifact"
ls -l "dist/$artifact"
