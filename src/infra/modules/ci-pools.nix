# CI pools: each pool keeps one fresh rig VM registered with GitHub as a
# just-in-time runner. The VM runs exactly one job, powers off, and is deleted;
# the orchestrator then makes the next one. See ../ci/orchestrate.sh.
#
# Everything GitHub-specific is in the orchestrator's one API call; the image
# and this module do not care which CI system hands out jobs.
{ config, lib, pkgs, ... }:

let
  cfg = config.services.ci-pools;
  poolOpts = { name, ... }: {
    options = {
      labels = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        description = "Runner labels jobs target with runs-on. self-hosted/Linux/X64 are added by the runner itself.";
      };
      image = lib.mkOption {
        type = lib.types.str;
        default = "ci-guest";
        description = "Incus image alias built from ci/guest (rig image build --alias).";
      };
      cpus = lib.mkOption { type = lib.types.int; default = 4; };
      memory = lib.mkOption { type = lib.types.str; default = "8GiB"; };
      disk = lib.mkOption { type = lib.types.str; default = "40GiB"; };
      atticTokenSecret = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "sops secret name holding an Attic client token for this pool (pull-only for untrusted pools).";
      };
      maxJobSeconds = lib.mkOption { type = lib.types.int; default = 6 * 3600; };
      atticGuestPort = lib.mkOption {
        type = lib.types.port;
        default = 8080;
        description = ''
          Port inside the guest at which Attic appears. rig forward keys its
          host-side vsock listener on this number, so each pool needs its own.
        '';
      };
    };
  };
in {
  options.services.ci-pools = {
    enable = lib.mkEnableOption "rig-backed ephemeral CI runner pools";
    org = lib.mkOption {
      type = lib.types.str;
      example = "ezcorg";
      description = ''
        GitHub organization the runners register with (its Default runner
        group). Any of its repositories can target the pools' labels; public
        ones only if the group allows public repositories.
      '';
    };
    githubTokenSecret = lib.mkOption {
      type = lib.types.str;
      default = "github/runner-pat";
      description = "sops secret: a token allowed to create JIT runner configs for the org (Self-hosted runners: read and write).";
    };
    pools = lib.mkOption {
      type = lib.types.attrsOf (lib.types.submodule poolOpts);
      default = { };
    };
  };

  config = lib.mkIf cfg.enable {
    users.users.ci = {
      isSystemUser = true;
      group = "ci";
      home = "/var/lib/ci";
      createHome = true;
      extraGroups = [ "incus-admin" ];   # rig drives Incus through its socket
    };
    users.groups.ci = { };

    # Credentials are loaded when a pool service starts, so a changed secret
    # must restart the pools that use it.
    sops.secrets = {
      ${cfg.githubTokenSecret}.restartUnits =
        lib.mapAttrsToList (name: _: "ci-pool-${name}.service") cfg.pools;
    }
    // lib.mapAttrs' (name: p: lib.nameValuePair p.atticTokenSecret {
         restartUnits = [ "ci-pool-${name}.service" ];
       }) (lib.filterAttrs (_: p: p.atticTokenSecret != null) cfg.pools);

    systemd.services = lib.mapAttrs' (name: p: lib.nameValuePair "ci-pool-${name}" {
      description = "CI pool ${name}: one fresh rig VM per job";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" "incus.service" "atticd.service" ];
      wants = [ "network-online.target" ];
      requires = [ "incus.service" ];
      environment = {
        POOL = name;
        ORG = cfg.org;
        LABELS = lib.concatStringsSep "," p.labels;
        IMAGE = p.image;
        CPUS = toString p.cpus;
        MEMORY = p.memory;
        DISK = p.disk;
        MAX_JOB_SECONDS = toString p.maxJobSeconds;
        ATTIC_GUEST_PORT = toString p.atticGuestPort;
        HOME = "/var/lib/ci";
      };
      serviceConfig = {
        User = "ci";
        Group = "ci";
        ExecStart = lib.getExe pkgs.ci-orchestrate;
        Restart = "always";
        RestartSec = 15;
        RuntimeDirectory = "ci-pool-${name}";
        RuntimeDirectoryMode = "0700";
        # Secrets stay root-owned on disk; systemd hands copies to the service.
        LoadCredential = [ "github-token:${config.sops.secrets.${cfg.githubTokenSecret}.path}" ]
          ++ lib.optional (p.atticTokenSecret != null)
               "attic-token:${config.sops.secrets.${p.atticTokenSecret}.path}";
      };
    }) cfg.pools;
  };
}
