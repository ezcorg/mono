# Task runner for the mono workspace.
#
#   cargo install --locked just cargo-deny cargo-nextest
#
# `just qq` is the fast pre-commit gate; `just qa` is what CI runs.
# Structure borrowed from plabayo/rama (MIT/Apache-2.0).

set positional-arguments

default:
    @just --list

# ---------------------------------------------------------------- formatting --

fmt:
    cargo fmt --all

fmt-check:
    cargo fmt --all --check

# --------------------------------------------------------------------- build --

check:
    cargo check --workspace --all-targets

check-no-default-features:
    cargo check --package witmproxy --no-default-features

# Every feature flag compiles on its own, not just in the default combination.
check-features:
    cargo check --package witmproxy --no-default-features
    cargo check --package witmproxy --no-default-features --features otel
    cargo check --package witmproxy --no-default-features --features test-helpers
    cargo check --package witmproxy --all-features

# --------------------------------------------------------------------- lints --

clippy:
    cargo clippy --workspace --all-targets -- -D warnings

# Report the panic-adjacent lint backlog without failing, so the `warn` ->
# `deny` migration in [workspace.lints] can be tracked.
clippy-panics:
    @cargo clippy --package witmproxy --all-targets --message-format=short 2>&1 \
        | grep -E 'unwrap_used|expect_used|clippy::panic|indexing_slicing' \
        | sed -E 's/.*(clippy::[a-z_]+).*/\1/' | sort | uniq -c | sort -rn || true

doc:
    RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps --all-features

# --------------------------------------------------------------------- tests --

test:
    cargo nextest run --package witmproxy --lib

test-all:
    cargo nextest run --workspace

test-doc:
    cargo test --doc --workspace

# Adversarial plugin suite: hostile WASM components exercised against the host.
test-adversarial:
    cargo nextest run --package witmproxy --lib adversarial -- --nocapture

# ------------------------------------------------------------ supply  chain --

deny:
    cargo deny check

audit: deny

# ------------------------------------------------------------------ aggregate --

# Fast gate; run before every commit.
qq: fmt-check check clippy

# Full gate; mirrors CI.
qa: qq check-features doc test test-doc deny
