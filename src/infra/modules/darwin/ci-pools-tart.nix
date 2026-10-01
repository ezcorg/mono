# macOS CI pools on Tart: each pool is a LaunchAgent keeping one fresh VM
# registered with GitHub as a just-in-time runner. The VM runs one job, shuts
# itself down, and is deleted. Mirrors modules/ci-pools.nix on Linux; the
# orchestrator differs only in how a VM is made and reached.
{ config, lib, pkgs, self, ... }:

let
  cfg = config.services.ci-pools-tart;
  orchestrate = self.packages.${pkgs.stdenv.hostPlatform.system}.ci-orchestrate-tart;
  poolOpts = { ... }: {
    options = {
      labels = lib.mkOption { type = lib.types.listOf lib.types.str; };
      image = lib.mkOption { type = lib.types.str; default = "ci-macos"; };
      cpus = lib.mkOption { type = lib.types.int; default = 4; };
      memory = lib.mkOption { type = lib.types.int; default = 8192; description = "MiB"; };
      atticTokenSecret = lib.mkOption { type = lib.types.nullOr lib.types.str; default = null; };
      maxJobSeconds = lib.mkOption { type = lib.types.int; default = 6 * 3600; };
    };
  };
in {
  options.services.ci-pools-tart = {
    enable = lib.mkEnableOption "Tart-backed ephemeral CI runner pools";
    repo = lib.mkOption { type = lib.types.str; };
    user = lib.mkOption {
      type = lib.types.str;
      description = "The logged-in user the pools run as; Tart needs a user session.";
    };
    attic = lib.mkOption {
      type = lib.types.str;
      description = "Attic URL as reachable from this host; tunnelled into each VM as 127.0.0.1:8080.";
    };
    githubTokenSecret = lib.mkOption { type = lib.types.str; default = "github/runner-pat"; };
    guestKey = lib.mkOption {
      type = lib.types.str;
      default = "/Users/${cfg.user}/.ssh/ci-guest";
      description = "SSH key the orchestrator uses to reach a VM; its public half is baked into the image.";
    };
    pools = lib.mkOption { type = lib.types.attrsOf (lib.types.submodule poolOpts); default = { }; };
  };

  config = lib.mkIf cfg.enable {
    sops.secrets = {
      ${cfg.githubTokenSecret} = { owner = cfg.user; };
    }
    // lib.mapAttrs' (_: p: lib.nameValuePair p.atticTokenSecret { owner = cfg.user; })
         (lib.filterAttrs (_: p: p.atticTokenSecret != null) cfg.pools);

    launchd.user.agents = lib.mapAttrs' (name: p: lib.nameValuePair "ci-pool-${name}" {
      serviceConfig = {
        ProgramArguments = [ "${lib.getExe orchestrate}" ];
        RunAtLoad = true;
        KeepAlive = true;
        ThrottleInterval = 15;
        StandardOutPath = "/Users/${cfg.user}/Library/Logs/ci-pool-${name}.log";
        StandardErrorPath = "/Users/${cfg.user}/Library/Logs/ci-pool-${name}.log";
        EnvironmentVariables = {
          PATH = "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
          HOME = "/Users/${cfg.user}";
          POOL = name;
          REPO = cfg.repo;
          LABELS = lib.concatStringsSep "," p.labels;
          IMAGE = p.image;
          CPUS = toString p.cpus;
          MEMORY = toString p.memory;
          MAX_JOB_SECONDS = toString p.maxJobSeconds;
          ATTIC_HOST_URL = cfg.attic;
          GUEST_KEY = cfg.guestKey;
          GITHUB_TOKEN_FILE = config.sops.secrets.${cfg.githubTokenSecret}.path;
          STATE_DIR = "/Users/${cfg.user}/Library/Application Support/ci-pool-${name}";
        } // lib.optionalAttrs (p.atticTokenSecret != null) {
          ATTIC_TOKEN_FILE = config.sops.secrets.${p.atticTokenSecret}.path;
        };
      };
    }) cfg.pools;
  };
}
