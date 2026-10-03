# Build-host infrastructure: the NixOS CI host (pengutron) and, later, the
# macOS one (galatron) via nix-darwin. See README.md.
#
#   nix flake check ./src/infra
#   sudo nixos-rebuild switch --flake ./src/infra#pengutron      # on pengutron
{
  description = "ezcorg build hosts";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    sops-nix = {
      url = "github:Mic92/sops-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nix-darwin = {
      url = "github:nix-darwin/nix-darwin/nix-darwin-26.05";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, sops-nix, nix-darwin, ... }:
    let
      linux = "x86_64-linux";
      darwin = "aarch64-darwin";
      # allowUnfree: tart (FSL) on darwin, the NVIDIA driver on linux.
      pkgsFor = system: import nixpkgs { inherit system; config.allowUnfree = true; };
    in {
      # galatron: the macOS build host. Tart VMs, one per job.
      #   sudo darwin-rebuild switch --flake ./src/infra#galatron
      darwinConfigurations.galatron = nix-darwin.lib.darwinSystem {
        system = darwin;
        specialArgs = { inherit self; };
        modules = [
          sops-nix.darwinModules.sops
          ./modules/darwin/ci-pools-tart.nix
          ./hosts/galatron
        ];
      };

      nixosConfigurations.pengutron = nixpkgs.lib.nixosSystem {
        system = linux;
        specialArgs = { inherit self; };
        modules = [
          sops-nix.nixosModules.sops
          ./modules/common.nix
          ./modules/attic.nix
          ./modules/sccache-store.nix
          ./modules/incus-rig.nix
          ./modules/ci-pools.nix
          ./hosts/pengutron
        ];
      };

      packages.${linux} = {
        rig = (pkgsFor linux).callPackage ./pkgs/rig.nix { };
        ci-orchestrate = (pkgsFor linux).callPackage ./pkgs/ci-orchestrate.nix { };
      };

      overlays.default = final: prev: {
        rig = final.callPackage ./pkgs/rig.nix { };
        ci-orchestrate = final.callPackage ./pkgs/ci-orchestrate.nix { };
      };

      packages.${darwin} = {
        tart = (pkgsFor darwin).callPackage ./pkgs/tart.nix { };
        ci-orchestrate-tart = (pkgsFor darwin).callPackage ./pkgs/ci-orchestrate-tart.nix { };
        ci-macos-image = (pkgsFor darwin).callPackage ./pkgs/ci-macos-image.nix { };
      };

      formatter.${linux} = (pkgsFor linux).nixfmt-rfc-style;
      formatter.${darwin} = (pkgsFor darwin).nixfmt-rfc-style;
    };
}
