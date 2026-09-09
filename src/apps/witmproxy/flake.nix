{
  description = "witmproxy — a WASM-in-the-middle proxy — development shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      rust-overlay,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ (import rust-overlay) ];
        };

        # The crate needs nightly (`#![feature(impl_trait_in_bindings)]` in
        # src/lib.rs). Pinned to the toolchain the tree is known to build with;
        # bump the date when the required feature set changes (rust-overlay
        # resolves the component hashes itself, no sha256 to maintain).
        rustToolchain = pkgs.rust-bin.nightly."2026-04-14".default.override {
          extensions = [
            "rust-src"
            "rust-analyzer"
            "clippy"
            "rustfmt"
          ];
          # wasm32-wasip2 is required to build the bundled test plugins
          # (wasm-test-component / noop / noshorts) that the integration tests
          # compile and load. See src/test_utils/mod.rs.
          targets = [ "wasm32-wasip2" ];
        };
      in
      {
        devShells.default = pkgs.mkShell {
          name = "witmproxy-dev";

          nativeBuildInputs = with pkgs; [
            rustToolchain
            pkg-config
            git # vendored submodules: conf-rs, wrpc
            perl # builds the vendored OpenSSL that SQLCipher (and cargo-generate) link
            cmake # libgit2 for cargo-generate's `plugin-new` feature + assorted -sys crates
            protobuf # opentelemetry-otlp gRPC codegen (the optional `otel` feature)
            # WASM component tooling for building / inspecting plugins.
            wasm-tools
            wkg
          ];

          # libsqlite3-sys is built with `bundled-sqlcipher-vendored-openssl`, so
          # SQLCipher and OpenSSL are compiled from source — no system sqlite or
          # openssl is linked, just the C/C++ toolchain from stdenv (+ perl above).
          # reqwest uses rustls (not native-tls), so no Security framework is
          # needed for TLS on macOS.
          buildInputs = pkgs.lib.optionals pkgs.stdenv.isDarwin [ pkgs.libiconv ];

          env.RUST_BACKTRACE = "1";

          shellHook = ''
            echo "witmproxy dev shell — $(rustc --version)"
            echo ""
            echo "  cargo build -p witmproxy --bins   # build the 'witm' CLI/daemon"
            echo "  cargo test  -p witmproxy --lib    # run the library tests"
            echo "  (cd src/rust/witmproxy-plugin-noop && make)   # build+sign a test plugin"
            echo ""
            # wasmsign2 signs plugin components; it is not packaged in nixpkgs.
            # The plugin Makefiles run 'cargo install wasmsign2-cli' on demand.
            if ! command -v wasmsign2 >/dev/null 2>&1; then
              echo "  note: 'wasmsign2' not on PATH — 'make' in a plugin dir installs it via cargo."
            fi
          '';
        };

        # `nix fmt` formats the flake(s).
        formatter = pkgs.nixfmt;
      }
    );
}
