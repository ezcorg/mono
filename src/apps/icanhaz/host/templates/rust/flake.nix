{
  description = "icanhaz capability — development shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { self, nixpkgs, rust-overlay, flake-utils }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ (import rust-overlay) ];
        };
        # A capability compiles to a `wasm32-wasip2` component: stable Rust
        # plus the wasi target, nothing nightly.
        rustToolchain = pkgs.rust-bin.stable.latest.default.override {
          extensions = [ "rust-src" "rust-analyzer" "clippy" "rustfmt" ];
          targets = [ "wasm32-wasip2" ];
        };
      in
      {
        devShells.default = pkgs.mkShell {
          name = "icanhaz-capability-dev";
          nativeBuildInputs = with pkgs; [
            rustToolchain
            wasm-tools # inspect / validate the built component
            wac # compose components
          ];
          buildInputs = pkgs.lib.optionals pkgs.stdenv.isDarwin [ pkgs.libiconv ];
          shellHook = ''
            echo "icanhaz capability dev shell — $(rustc --version)"
            echo "  cargo build --release --target wasm32-wasip2"
            echo "  icanhaz capability inspect target/wasm32-wasip2/release/{{crate}}.wasm"
            echo "  icanhaz capability add     target/wasm32-wasip2/release/{{crate}}.wasm"
          '';
        };
        formatter = pkgs.nixfmt;
      }
    );
}
