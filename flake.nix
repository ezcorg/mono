# The workspace dev shell: the pinned Rust toolchain (rust-toolchain.toml),
# Node and pnpm, and the system libraries the crates link against. CI jobs on
# the self-hosted pools enter it with `nix develop -c <command>`; the same
# shell works on a laptop.
#
# Per-project flakes (src/apps/witmproxy, src/rust/wrpc) stay as they are;
# this is the lowest common denominator for the whole monorepo.
{
  description = "ezcorg mono: workspace dev shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, rust-overlay }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" "x86_64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f system);
      toolchainFile = builtins.fromTOML (builtins.readFile ./rust-toolchain.toml);
    in {
      devShells = forAll (system:
        let
          pkgs = import nixpkgs { inherit system; overlays = [ rust-overlay.overlays.default ]; };
          inherit (pkgs) lib stdenv;
          # rust-toolchain.toml, plus the Apple targets a macOS host cross-builds
          # for (witm ships x86_64 and arm64 macOS binaries from one runner).
          rust = pkgs.rust-bin.fromRustupToolchain (toolchainFile.toolchain // {
            targets = toolchainFile.toolchain.targets
              ++ lib.optionals stdenv.isDarwin [ "x86_64-apple-darwin" "aarch64-apple-darwin" ];
          });
        in {
          default = pkgs.mkShell {
            name = "mono";
            packages = with pkgs; [
              rust
              nodejs_22
              pnpm_10          # pnpm switches itself to package.json's packageManager version
              pkg-config
              cmake
              gnumake
              just
              git
              wasm-tools
              # Portable Linux release binaries from a NixOS host: `cargo zigbuild
              # --target x86_64-unknown-linux-gnu.2.28` links against an old glibc
              # instead of the Nix store's.
              cargo-zigbuild
              zig_0_14
              perl             # openssl-src (vendored by sqlcipher) configures with perl
            ] ++ lib.optionals stdenv.isDarwin [ libiconv ]
              # Browser for the vitest browser tests; the Linux CI image also
              # exposes it as /usr/bin/google-chrome for configs that hardcode it.
              ++ lib.optionals stdenv.isLinux [ chromium ];
            shellHook = ''
              export CARGO_NET_GIT_FETCH_WITH_CLI=true
              # Tools the scripts `cargo install` on demand (wasmsign2, wkg).
              export PATH="$HOME/.cargo/bin:$PATH"
            '';
          };
        });

      formatter = forAll (system: nixpkgs.legacyPackages.${system}.nixfmt-rfc-style);
    };
}
