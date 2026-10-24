{
  description = "icanhaz — the language-agnostic core for authoring capabilities";

  # Only what every capability author needs regardless of language: the
  # component tools. Each scaffold's own flake layers its language on top
  # (cargo + the wasip2 target for Rust, jco for JavaScript, …), so nobody
  # pays for the others.
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          name = "icanhaz-capability-core";
          nativeBuildInputs = with pkgs; [
            wasm-tools # validate, print and manipulate components
            wac # compose components
            wit-bindgen # generate bindings for any language it supports
          ];
          shellHook = ''
            echo "icanhaz capability core shell: wasm-tools, wac, wit-bindgen"
            echo "  icanhaz capability new <name> --export <interface>"
            echo "  icanhaz capability wrap <interface>"
            echo "  icanhaz capability inspect|add|list|get|compose"
          '';
        };
        formatter = pkgs.nixfmt;
      }
    );
}
