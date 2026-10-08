# From `nixos-generate-config --show-hardware-config` on the live installer
# (MSI GE73VR 7RF), with the filesystems added by hand: the disk keeps the
# GPT the previous OS left (1 GiB ESP + the rest), so the partitions are
# named by PARTUUID, which a reformat does not change.
{ config, lib, pkgs, modulesPath, ... }:

{
  imports =
    [ (modulesPath + "/installer/scan/not-detected.nix")
    ];

  boot.initrd.availableKernelModules = [ "xhci_pci" "ahci" "nvme" "usb_storage" "sd_mod" "sdhci_pci" ];
  boot.initrd.kernelModules = [ ];
  boot.kernelModules = [ "kvm-intel" ];
  boot.extraModulePackages = [ ];

  fileSystems."/" =
    { device = "/dev/disk/by-partuuid/0a54fa38-5bb5-4a26-9b86-abba91534163";
      fsType = "ext4";
    };

  fileSystems."/boot" =
    { device = "/dev/disk/by-partuuid/ede1090e-0ad6-43a3-b390-13459e8e0bc6";
      fsType = "vfat";
      options = [ "fmask=0077" "dmask=0077" ];
    };

  # 16 GB of RAM and no battery; a swapfile rather than a partition, so the
  # layout above stays as found. The 1 TB HDD (sda) is left untouched.
  swapDevices = [ { device = "/var/swapfile"; size = 8 * 1024; } ];

  nixpkgs.hostPlatform = lib.mkDefault "x86_64-linux";
  hardware.cpu.intel.updateMicrocode = lib.mkDefault config.hardware.enableRedistributableFirmware;
}
