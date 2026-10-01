# The host side of a macOS CI pool: one fresh Tart VM per job. See ../ci/macos/orchestrate.sh.
{ writeShellApplication, curl, jq, coreutils, callPackage }:

writeShellApplication {
  name = "ci-orchestrate-tart";
  # ssh/scp are deliberately Apple's (/usr/bin): macOS grants Local Network
  # access to signed system binaries, and refuses it to Nix-built ones with
  # "No route to host" when they try to reach a VM on the vmnet bridge.
  runtimeInputs = [ curl jq coreutils (callPackage ./tart.nix { }) ];
  text = builtins.readFile ../ci/macos/orchestrate.sh;
}
