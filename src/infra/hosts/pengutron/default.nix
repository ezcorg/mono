# pengutron: the Linux build host. Attic, Incus + rig, and the CI pools.
{ config, pkgs, ... }:

{
  imports = [ ./hardware.nix ];

  boot.loader.systemd-boot.enable = true;
  boot.loader.systemd-boot.configurationLimit = 10;
  boot.loader.efi.canTouchEfiVariables = true;

  networking.hostName = "pengutron";
  networking.networkmanager.enable = true;
  time.timeZone = "America/Vancouver";

  users.users.theo = {
    isNormalUser = true;
    extraGroups = [ "wheel" "networkmanager" "incus-admin" ];
    openssh.authorizedKeys.keys = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOPscR1MCZgcScK+tsqfHdOMcWlXRxU7KY5aCKctXS/k theo@Theodores-MBP-2.lan"
    ];
  };

  services.openssh = {
    enable = true;
    settings = {
      PasswordAuthentication = false;
      PermitRootLogin = "no";
    };
  };

  services.tailscale = {
    enable = true;
    openFirewall = true;
    extraSetFlags = [ "--ssh" ];
    # Consumed on first join; the node is authenticated now, so the file can go.
    authKeyFile = "/var/lib/tailscale-authkey";
  };
  networking.firewall.trustedInterfaces = [ "tailscale0" ];

  # Secrets: decrypted at boot with the host's SSH key (see ../../.sops.yaml).
  sops.defaultSopsFile = ../../secrets/pengutron.yaml;
  sops.age.sshKeyPaths = [ "/etc/ssh/ssh_host_ed25519_key" ];

  services.ci-pools = {
    enable = true;
    repo = "ezcorg/mono";
    pools = {
      # Pull requests and anything else untrusted: reads the cache, cannot write
      # it. Three identical pools so PR jobs run in parallel (the host has 16
      # cores and 62 GB; four VMs at 4 cores / 8 GB leave it plenty).
      linux = {
        labels = [ "nix" "linux-vm" ];
        atticTokenSecret = "attic/token-ci";
        atticGuestPort = 8080;
      };
      linux-2 = {
        labels = [ "nix" "linux-vm" ];
        atticTokenSecret = "attic/token-ci";
        atticGuestPort = 8082;
      };
      linux-3 = {
        labels = [ "nix" "linux-vm" ];
        atticTokenSecret = "attic/token-ci";
        atticGuestPort = 8083;
      };
      # Jobs on main: may push what they build to the cache.
      linux-trusted = {
        labels = [ "nix" "linux-vm-trusted" ];
        atticTokenSecret = "attic/token-ci-trusted";
        atticGuestPort = 8081;
      };
    };
  };

  # NVIDIA GTX 1070 (Pascal). Kept for a future GPU VM via rig; nothing on the
  # host drives a display.
  nixpkgs.config.allowUnfree = true;
  hardware.graphics.enable = true;
  services.xserver.videoDrivers = [ "nvidia" ];
  hardware.nvidia = {
    package = config.boot.kernelPackages.nvidiaPackages.legacy_580;
    open = false;
    nvidiaPersistenced = true;
  };

  environment.systemPackages = with pkgs; [ nvtopPackages.nvidia ];

  system.stateVersion = "26.05";
}
