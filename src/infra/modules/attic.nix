# Attic: the binary cache both build hosts read from and trusted jobs push to.
#
# Reachable on port 17080 over the tailnet only. rig guests cannot reach the
# host's addresses at all (that is the point of rig), so every guest sees it at
# 127.0.0.1:17080 instead: over vsock on pengutron (modules/ci-pools.nix), over
# SSH on galatron.
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
      listen = "0.0.0.0:17080";
      # What `attic use` and `attic push` switch to after the first request.
      # Every client is a guest or this host, and each sees Attic here; the
      # tailnet name would send a guest's push where it has no route. Reach
      # it from elsewhere with `ssh -L 17080:127.0.0.1:17080 pengutron`.
      api-endpoint = "http://127.0.0.1:17080/";
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
