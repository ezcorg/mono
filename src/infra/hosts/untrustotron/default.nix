# untrustotron: the MSI GE73VR laptop, a dumb bench box for reverse engineering
# untrusted devices and protocols. Nothing is analysed here and no RE tools
# are installed: another host reaches it over the tailnet and uses what is
# plugged into it (USB over USB/IP, serial adapters, the wired port). On the
# tailnet it is a destination only: its tag has no `src` rule in the policy,
# so it can see nothing else (see README, "untrustotron").
{ config, pkgs, ... }:

{
  imports = [ ./hardware.nix ];

  boot.loader.systemd-boot.enable = true;
  boot.loader.systemd-boot.configurationLimit = 10;
  boot.loader.efi.canTouchEfiVariables = true;

  networking.hostName = "untrustotron";
  time.timeZone = "America/Vancouver";

  # Uplink is Wi-Fi. Its profile is state, not config: at install time it is
  # copied from the installer's NetworkManager into the new root (README), so
  # the PSK lives only on the laptop.
  networking.networkmanager.enable = true;
  # The wired port is the lab port, where untrusted devices get plugged in.
  # NetworkManager leaves it alone: no DHCP client, no route, no DNS taken
  # from whatever sits on it; the operator addresses it by hand per
  # experiment (`ip addr add … dev enp5s0`).
  networking.networkmanager.unmanaged = [ "enp5s0" ];
  # Nor may the kernel take a default route from a router advertisement
  # there, and this box forwards nothing between its ports.
  boot.kernel.sysctl = {
    "net.ipv6.conf.enp5s0.accept_ra" = 0;
    "net.ipv6.conf.enp5s0.autoconf" = 0;
    "net.ipv4.conf.all.forwarding" = 0;
    "net.ipv6.conf.all.forwarding" = 0;
  };

  users.users.theo = {
    isNormalUser = true;
    # dialout: serial adapters without sudo.
    extraGroups = [ "wheel" "networkmanager" "dialout" ];
    openssh.authorizedKeys.keys = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOPscR1MCZgcScK+tsqfHdOMcWlXRxU7KY5aCKctXS/k theo@Theodores-MBP-2.lan"
    ];
  };

  services.openssh = {
    enable = true;
    # Reachable over the tailnet and, as the fallback, the Wi-Fi LAN; never
    # from the lab port.
    openFirewall = false;
    settings = {
      PasswordAuthentication = false;
      PermitRootLogin = "no";
    };
  };
  networking.firewall.trustedInterfaces = [ "tailscale0" ];
  networking.firewall.interfaces.wlp2s0.allowedTCPPorts = [ 22 ];

  services.tailscale = {
    enable = true;
    openFirewall = true;
    extraSetFlags = [ "--ssh" ];
    # The node is tagged; the tag is what the policy restricts. The key must
    # be minted for tag:untrustotron (README). Consumed on first join; the file
    # can go afterwards. `--ssh` again here because `tailscale up` refuses to
    # run unless every non-default preference is on its command line.
    extraUpFlags = [ "--advertise-tags=tag:untrustotron" "--ssh" ];
    authKeyFile = "/var/lib/tailscale-authkey";
    # Not an exit node, not a subnet router: it carries nothing for anyone.
    useRoutingFeatures = "none";
  };
  # Without the key file the join unit would sit waiting for an interactive
  # login and fail every switch; skip it until the file is there, then
  # `systemctl start tailscaled-autoconnect`.
  systemd.services.tailscaled-autoconnect.unitConfig.ConditionPathExists =
    config.services.tailscale.authKeyFile;

  # USB/IP: a device bound here with `sudo usbip bind -b <busid>` is attached
  # on the other host with `usbip attach -r untrustotron -b <busid>`. usbipd
  # listens on 3240 everywhere, which the firewall admits on tailscale0 only.
  boot.kernelModules = [ "usbip_host" ];
  systemd.services.usbipd = {
    description = "USB/IP server";
    wantedBy = [ "multi-user.target" ];
    after = [ "network.target" ];
    serviceConfig = {
      ExecStart = "${config.boot.kernelPackages.usbip}/bin/usbipd";
      Restart = "on-failure";
    };
  };

  environment.systemPackages = with pkgs; [
    config.boot.kernelPackages.usbip
    usbutils      # lsusb
    picocom       # a serial console when one is needed from here
    ethtool iw
  ];

  # A headless laptop: the lid is shut and it never sleeps.
  services.logind.settings.Login = {
    HandleLidSwitch = "ignore";
    HandleLidSwitchExternalPower = "ignore";
    HandleLidSwitchDocked = "ignore";
  };
  systemd.sleep.settings.Sleep = {
    AllowSuspend = "no";
    AllowHibernation = "no";
  };

  # The GTX 1070 drives nothing; the Intel iGPU has the console. Keep nouveau
  # from probing it (power, and the occasional hang on this generation).
  boot.blacklistedKernelModules = [ "nouveau" ];

  system.stateVersion = "26.05";
}
