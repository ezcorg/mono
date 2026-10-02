# The host side of a CI pool: one fresh rig VM per job. See ../ci/orchestrate.sh.
{ lib, writeShellApplication, curl, jq, coreutils, callPackage }:

writeShellApplication {
  name = "ci-orchestrate";
  runtimeInputs = [ curl jq coreutils (callPackage ./rig.nix { }) ];
  text = builtins.readFile ../ci/orchestrate.sh;
}
