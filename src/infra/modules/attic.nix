# Attic: the binary cache both build hosts read from and trusted jobs push to.
#
# Reachable on port 8080 over the tailnet only. rig guests cannot reach the
# host's addresses at all (that is the point of rig), so the orchestrator
# tunnels 127.0.0.1:8080 into each VM over vsock instead.
#
# After the first switch, mint client tokens (see README):
#   sudo atticd-atticadm make-token --sub ci --validity 1y --pull mono
#   sudo atticd-atticadm make-token --sub ci-trusted --validity 1y --pull mono --push mono
{ config, ... }:

{
  sops.secrets."attic/env" = { };   # ATTIC_SERVER_TOKEN_HS256_SECRET_BASE64=...

  services.atticd = {
    enable = true;
    environmentFile = config.sops.secrets."attic/env".path;
    settings = {
      listen = "0.0.0.0:8080";
      # What `attic use` tells clients to talk to; the tailnet name.
      api-endpoint = "http://pengutron.tailb1a1.ts.net:8080/";
      storage = {
        type = "local";
        path = "/var/lib/atticd/storage";
      };
      # Content-defined chunking: unchanged chunks of a rebuilt path are not stored twice.
      chunking = {
        nar-size-threshold = 64 * 1024;
        min-size = 16 * 1024;
        avg-size = 64 * 1024;
        max-size = 256 * 1024;
      };
      compression.type = "zstd";
      garbage-collection = {
        interval = "12 hours";
        default-retention-period = "3 months";
      };
    };
  };

  # The tailnet interface is trusted in hosts/pengutron, so no port is opened
  # on the LAN side here on purpose.
}
