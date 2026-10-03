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
    # Runners belong to the org: any ezcorg repository (mono, dij) can use them.
    org = "ezcorg";
    pools = let
      # Pull requests and anything else untrusted: reads the caches, cannot
      # write them.
      untrusted = {
        labels = [ "nix" "linux-vm" ];
        atticTokenSecret = "attic/token-ci";
        sccacheKeySecret = "sccache/key-ro";
      };
    in {
      # Three identical pools so PR jobs run in parallel. With the trusted
      # pool that is 20 vCPUs on 16 cores and 40 GB of 62: idle VMs cost little.
      linux = untrusted;
      linux-2 = untrusted;
      linux-3 = untrusted;
      # Jobs on main and releases: may write what they build to the caches.
      # Bigger, since they queue for one VM and are CPU-bound.
      linux-trusted = {
        labels = [ "nix" "linux-vm-trusted" ];
        atticTokenSecret = "attic/token-ci-trusted";
        sccacheKeySecret = "sccache/key-rw";
        sccacheWrite = true;
        trustedRepos = [ "ezcorg/mono" "ezcorg/dij" ];
        cpus = 8;
        memory = "16GiB";
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
