# syntax=docker/dockerfile:1.7

# ---------- Builder ----------------------------------------------------------
# witmproxy needs nightly Rust (matches .github/workflows/witmproxy-test.yml).
FROM rust:slim-bookworm AS builder

RUN rustup toolchain install nightly --profile minimal \
 && rustup default nightly

# Build deps:
# - build-essential, clang, cmake: cel-cxx (C++ FFI) and CMake-driven crates
# - perl, make:                    vendored OpenSSL (for sqlcipher)
# - pkg-config, ca-certificates:   general
# - git:                           witmproxy's build.rs reads ../../.git/HEAD
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        clang \
        cmake \
        git \
        make \
        perl \
        pkg-config \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY . .

# Cache cargo registry/git index and the target dir across builds.
# `target/` is on a cache mount, so copy the binary out before the mount unmounts.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/workspace/target \
    cargo build --package witmproxy --bin witm --release \
 && cp target/release/witm /usr/local/bin/witm

# ---------- Runtime ----------------------------------------------------------
FROM debian:bookworm-slim AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/local/bin/witm /usr/local/bin/witm
COPY src/apps/witmproxy/scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Default state directory on Linux (db, certs, config). Mount a volume here
# to persist generated CA, encrypted SQLite db, and config across restarts.
RUN mkdir -p /var/lib/witmproxy
VOLUME ["/var/lib/witmproxy"]

# Bind to all interfaces by default — the in-process defaults are 127.0.0.1:0,
# which is unusable from outside the container. Override via env or flags.
ENV PROXY_BIND_ADDR=0.0.0.0:8080 \
    WEB_BIND_ADDR=0.0.0.0:8000

EXPOSE 8000 8080

# The entrypoint prepends `run` when args are missing or look like flags, so:
#   docker run img                                      → witm run
#   docker run img --proxy-bind-addr 0.0.0.0:9000       → witm run --proxy-bind-addr 0.0.0.0:9000
#   docker run img ca install                           → witm ca install
ENTRYPOINT ["docker-entrypoint.sh"]
