# rig: isolated NixOS VMs on Incus (github.com/tbrockman/rig). The CI
# orchestrator drives it; `rig` is also on PATH for hand operation.
{ lib, buildGoModule, fetchFromGitHub }:

buildGoModule {
  pname = "rig";
  version = "0-unstable-2026-09-29";

  src = fetchFromGitHub {
    owner = "tbrockman";
    repo = "rig";
    rev = "5df0e2dc2a8fd5a52dd171bdab7894ee3a75283d";
    hash = "sha256-EsdkGEWq08j+VEcWI3EuRU5RSDak45GatItr6+u+3hY=";
  };
  vendorHash = "sha256-PTjpU8Xc/QvwmoOxpyNrHMLAFVlmsSZmR4vHgeWFzwI=";

  subPackages = [ "cmd/rig" ];
  # The integration tests need a live Incus and a GPU.
  doCheck = false;

  meta = {
    description = "Run untrusted things in isolated NixOS VMs on Incus";
    homepage = "https://github.com/tbrockman/rig";
    license = lib.licenses.agpl3Only;
    mainProgram = "rig";
  };
}
