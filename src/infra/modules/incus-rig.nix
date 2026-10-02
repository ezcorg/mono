# Incus, set up the way rig expects (docs/RUNBOOK.md in rig): a managed
# bridge, a copy-on-write storage pool so VM clones are instant, and the rig
# binary. `rig setup` (the isolation ACL and `rig` profile) is run once by
# hand after the first switch; it is idempotent.
{ config, pkgs, self, ... }:

{
  nixpkgs.overlays = [ self.overlays.default ];

  boot.supportedFilesystems = [ "btrfs" ];
  # The IOMMU, for the day a VM is given the GTX 1070. Harmless otherwise.
  boot.kernelParams = [ "amd_iommu=on" "iommu=pt" ];

  virtualisation.incus = {
    enable = true;
    preseed = {
      networks = [{
        name = "incusbr0";
        type = "bridge";
        config = {
          "ipv4.address" = "auto";
          "ipv4.nat" = "true";
          "ipv6.address" = "none";   # rig verify fails a guest with a global IPv6 address
        };
      }];
      storage_pools = [{
        name = "rig";
        driver = "btrfs";
        config.size = "300GiB";      # loop file under /var/lib/incus/disks
      }];
      profiles = [{
        name = "default";
        devices = {
          root = { path = "/"; pool = "rig"; type = "disk"; };
          eth0 = { name = "eth0"; network = "incusbr0"; type = "nic"; };
        };
      }];
    };
  };

  # nftables backend, which Incus's own rules and ACLs coexist with cleanly.
  networking.nftables.enable = true;

  # rig's ACL chains make the kernel run conntrack at the bridge layer. For a
  # broadcast frame the bridge conntrack deliberately drops its entry again
  # (it cannot confirm cloned skbs), so a guest's DHCP DISCOVER reaches the
  # host firewall with no state at all, which the NixOS input chain treats as
  # invalid and drops before dnsmasq sees it. Marking DHCP requests as
  # untracked before conntrack runs lets the firewall's normal DHCP allow
  # apply. Unicast traffic (DNS to the bridge, everything else) is unaffected.
  networking.nftables.tables.rig-dhcp = {
    family = "bridge";
    content = ''
      chain pre {
        type filter hook prerouting priority -300; policy accept;
        udp dport 67 notrack
      }
    '';
  };
  # Guests need DHCP and DNS from the bridge's dnsmasq; nothing else on the
  # host is exposed to the bridge.
  networking.firewall.interfaces.incusbr0 = {
    allowedUDPPorts = [ 53 67 ];
    allowedTCPPorts = [ 53 ];
  };

  # rig serialises device claims on /var/lock/rig.lock. /run/lock is root-only
  # on NixOS (1777 on Ubuntu), so give incus-admin a lock file it can open.
  systemd.tmpfiles.rules = [ "f /run/lock/rig.lock 0664 root incus-admin -" ];

  environment.systemPackages = [ pkgs.rig pkgs.attic-client ];
}
