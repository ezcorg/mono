# Settings every build host shares.
{ pkgs, ... }:

{
  nix.settings = {
    experimental-features = [ "nix-command" "flakes" ];
    trusted-users = [ "root" "@wheel" ];
    auto-optimise-store = true;
    # The host's own store is the first-level cache for anything built here.
    keep-outputs = true;
    keep-derivations = true;
  };
  nix.gc = {
    automatic = true;
    dates = "weekly";
    options = "--delete-older-than 30d";
  };

  environment.systemPackages = with pkgs; [ git vim htop jq pciutils tcpdump ];
}
