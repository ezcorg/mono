# CI pools: each pool keeps one fresh rig VM registered with GitHub as a
# just-in-time runner. The VM runs exactly one job, powers off, and is deleted;
# the orchestrator then makes the next one. See ../ci/orchestrate.sh.
#
# Everything GitHub-specific is in the orchestrator's one API call; the image
# and this module do not care which CI system hands out jobs.
#
# Guests have no route to this host. The services they need (Attic, the sccache
# store) sit at fixed ports on their 127.0.0.1, relayed over vsock: this module
# runs the host half, the guest image (ci/guest/guest.nix) the other.
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
      sccacheKeySecret = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = ''
          sops secret holding this pool's Garage key for the sccache store, as
          AWS_ACCESS_KEY_ID=… and AWS_SECRET_ACCESS_KEY=… lines (read-only for
          untrusted pools). Jobs see it, with the store's address, in their
          environment.
        '';
      };
      trustedRepos = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = [ "ezcorg/mono" "ezcorg/dij" ];
        description = ''
          Make this a trusted pool: its VMs run only jobs from these
          repositories, and only from main (pushes and manual runs) or tags;
          anything else fails before its first step (ci/guest/job-gate.sh).
          Empty: any job, as for the pull-request pools.
        '';
      };
      sccacheWrite = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Whether jobs write to the sccache store. Garage enforces the key's permissions either way; this only stops sccache trying.";
      };
      maxJobSeconds = lib.mkOption { type = lib.types.int; default = 6 * 3600; };
    };
  };

  # Every sops secret a pool loads, mapped to the units of the pools that load
  # it: a changed secret restarts each of them.
  poolSecrets = lib.zipAttrs (lib.concatLists (lib.mapAttrsToList (name: p:
    map (secret: { ${secret} = "ci-pool-${name}.service"; })
      (lib.filter (s: s != null) [ cfg.githubTokenSecret p.atticTokenSecret p.sccacheKeySecret ]))
    cfg.pools));
  relayUnits = lib.mapAttrsToList (name: _: "ci-vsock-${name}.service") cfg.hostServices;
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
    hostServices = lib.mkOption {
      type = lib.types.attrsOf lib.types.port;
      default = { attic = 17080; sccache = 17090; };
      description = ''
        Services on this host that every guest reaches at 127.0.0.1:<port>.
        This host relays vsock port <port> to its own 127.0.0.1:<port>; the
        guest image relays the other half (ci/guest/guest.nix), so keep the two
        in step. Any VM on this host can connect: the services authenticate.
        The ports are uncommon on purpose, and outside the Linux and macOS
        ephemeral ranges: in a guest the relay holds its port, and a job's own
        dev server or test fixture is likely to want 8080 or a service's default.
      '';
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
    sops.secrets = lib.mapAttrs (_: units: { restartUnits = units; }) poolSecrets;

    # The host half of the guests' 127.0.0.1 services. A vsock listener takes
    # connections from every VM, so one relay per service serves all pools at
    # the same port.
    boot.kernelModules = [ "vhost_vsock" ];

    systemd.services = lib.mapAttrs' (name: port: lib.nameValuePair "ci-vsock-${name}" {
      description = "Guests' 127.0.0.1:${toString port}: this host's ${name}, over vsock";
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        ExecStart = "${pkgs.socat}/bin/socat VSOCK-LISTEN:${toString port},reuseaddr,fork TCP:127.0.0.1:${toString port}";
        DynamicUser = true;
        Restart = "always";
        RestartSec = 5;
      };
    }) cfg.hostServices
    // lib.mapAttrs' (name: p: lib.nameValuePair "ci-pool-${name}" {
      description = "CI pool ${name}: one fresh rig VM per job";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" "incus.service" "atticd.service" ] ++ relayUnits;
      wants = [ "network-online.target" ] ++ relayUnits;
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
        SCCACHE_RW_MODE = if p.sccacheWrite then "READ_WRITE" else "READ_ONLY";
        CI_TRUSTED_REPOS = lib.concatStringsSep "," p.trustedRepos;
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
               "attic-token:${config.sops.secrets.${p.atticTokenSecret}.path}"
          ++ lib.optional (p.sccacheKeySecret != null)
               "sccache-key:${config.sops.secrets.${p.sccacheKeySecret}.path}";
      };
    }) cfg.pools;
  };
}
