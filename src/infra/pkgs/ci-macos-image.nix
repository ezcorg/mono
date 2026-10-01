# Builds the ci-macos Tart image from Cirrus's Tahoe base. See ../ci/macos/build-image.sh.
{ writeShellApplication, sshpass, curl, jq, coreutils, gnused, callPackage }:

writeShellApplication {
  name = "ci-macos-image";
  # No Nix openssh on purpose: see ci-orchestrate-tart.nix (Local Network privacy).
  runtimeInputs = [ sshpass curl jq coreutils gnused (callPackage ./tart.nix { }) ];
  text = builtins.replaceStrings [ "@guestDir@" ] [ "${../ci/macos}" ] (builtins.readFile ../ci/macos/build-image.sh);
}
