# The CI guest image: rig's base plus a single-use GitHub runner.
#
#   rig image build --flake ./src/infra/ci/guest --alias ci-guest      # on pengutron
#
# Rebuild and re-alias after changing guest.nix; pools pick the new image up
# on their next VM. Toolchains are not here: jobs get them from each project's
# flake (`nix develop -c ...`), served warm from Attic.
{
  description = "ezcorg CI guest image";

  inputs.rig.url = "github:tbrockman/rig/5df0e2dc2a8fd5a52dd171bdab7894ee3a75283d?dir=base";

  outputs = { rig, ... }: {
    nixosConfigurations.guest = rig.lib.mkGuest [ ./guest.nix ];
  };
}
