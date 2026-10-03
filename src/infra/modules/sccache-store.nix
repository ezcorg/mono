# Garage: the S3 store behind sccache, the compile cache CI jobs share.
#
# Guests reach it at 127.0.0.1:17090 (relayed over vsock, modules/ci-pools.nix);
# galatron's VMs through the tailnet. Untrusted pools hold a read-only key,
# trusted ones a read-write key, so a pull request cannot poison what main and
# release builds read. A bucket quota caps the size and a lifecycle rule expires
# objects 30 days after they were written. First-time setup is in README.md.
{ config, pkgs, ... }:

{
  sops.secrets."garage/env" = { };   # GARAGE_RPC_SECRET=<openssl rand -hex 32>

  services.garage = {
    enable = true;
    package = pkgs.garage_2;
    environmentFile = config.sops.secrets."garage/env".path;
    settings = {
      replication_factor = 1;   # one node
      db_engine = "lmdb";
      rpc_bind_addr = "127.0.0.1:3901";
      rpc_public_addr = "127.0.0.1:3901";
      s3_api = {
        s3_region = "garage";
        # Every interface, like Attic: the firewall trusts only tailscale0.
        api_bind_addr = "0.0.0.0:17090";
      };
    };
  };
}
