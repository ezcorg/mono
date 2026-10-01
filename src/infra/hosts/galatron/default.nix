# galatron: the macOS build host (M1 MacBook Pro, 16 GB). Tart VMs, one per job.
#
# Nix itself is Determinate Nix, which manages its own daemon; nix-darwin is
# told to leave it alone (nix.enable = false). Homebrew supplies tailscale and
# tart, since both need to be real macOS binaries with their entitlements.
{ config, pkgs, self, ... }:

{
  nixpkgs.hostPlatform = "aarch64-darwin";
  nixpkgs.config.allowUnfree = true;   # tart's license
  system.stateVersion = 6;
  system.primaryUser = "theo";
  users.users.theo.home = "/Users/theo";

  nix.enable = false;   # Determinate Nix owns /etc/nix and the daemon
  # macOS 27 refuses the symlink nix-darwin would put in /etc/pam.d, and the
  # only thing it carries (Touch ID for sudo) is useless on a headless host.
  security.pam.services.sudo_local.enable = false;
  # Access is Tailscale SSH only; keep macOS Remote Login (LAN sshd) off.
  services.openssh.enable = false;

  homebrew = {
    enable = true;
    brews = [ "tailscale" ];
    onActivation.cleanup = "none";   # never uninstall what was added by hand
  };

  environment.systemPackages = with pkgs; [ jq socat attic-client git ]
    ++ [ self.packages.${pkgs.stdenv.hostPlatform.system}.tart ];

  # A build host that must not sleep: not on battery, not with the lid shut.
  power.sleep.computer = "never";
  power.sleep.display = "never";
  system.activationScripts.postActivation.text = ''
    /usr/bin/pmset -a disablesleep 1 womp 1 >/dev/null
  '';
  # The pool runs as a LaunchAgent, which needs a logged-in session. With
  # FileVault on, the user who unlocks the disk at boot is logged in.
  system.defaults.loginwindow.autoLoginUser = "theo";

  # Secrets: the same file as pengutron, encrypted to this host's age key too.
  sops.defaultSopsFile = ../../secrets/pengutron.yaml;
  sops.age.keyFile = "/Users/theo/.config/sops/age/keys.txt";
  sops.age.sshKeyPaths = [ ];

  services.ci-pools-tart = {
    enable = true;
    repo = "ezcorg/mono";
    user = "theo";
    attic = "http://pengutron.tailb1a1.ts.net:8080";
    pools.macos = {
      labels = [ "nix" "macos-vm" ];
      atticTokenSecret = "attic/token-ci";
      cpus = 4;
      memory = 8192;
    };
  };
}
