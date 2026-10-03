# One job, then power off. The host injects /run/rig/env (tmpfs) after boot:
#   JIT_CONFIG    a single-use GitHub runner registration
#   ATTIC_URL     the cache, http://127.0.0.1:17080 (relayed, below)
#   ATTIC_TOKEN   optional; pull, or pull+push on the trusted pool
#   SCCACHE_*, AWS_*   optional; the sccache store at 127.0.0.1:17090, for jobs
#   CI_TRUSTED_REPOS   on a trusted pool: what its job gate lets through (job-gate.sh)
{ pkgs, lib, ... }:

let
  # The host's services, at fixed ports on this guest's 127.0.0.1: each is a
  # relay to vsock port <port> on the host (CID 2), which relays it on to the
  # service (modules/ci-pools.nix, hostServices, which says why these ports).
  # Keep the two in step.
  hostServices = { attic = 17080; sccache = 17090; };
  relayUnits = lib.mapAttrsToList (name: _: "host-${name}.service") hostServices;
in
{
  imports = [{
    systemd.services = lib.mapAttrs' (name: port: lib.nameValuePair "host-${name}" {
      description = "127.0.0.1:${toString port} is the host's ${name}, over vsock";
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        ExecStart = "${pkgs.socat}/bin/socat TCP-LISTEN:${toString port},bind=127.0.0.1,reuseaddr,fork VSOCK-CONNECT:2:${toString port}";
        DynamicUser = true;
        Restart = "always";
        RestartSec = 2;
      };
    }) hostServices;
  }];

  users.users.runner = {
    isNormalUser = true;
    home = "/var/lib/runner";
    createHome = true;
    uid = 1000;
  };

  # `attic use` writes substituters to the runner's own nix.conf; nix only
  # honours those from a trusted user. The VM is disposable, so that is fine.
  nix.settings.trusted-users = [ "runner" ];
  nix.settings.sandbox = true;

  # Prebuilt dynamically-linked binaries that actions download (rustup
  # toolchains, node) expect an FHS loader; nix-ld provides one.
  programs.nix-ld.enable = true;
  # Enough of an FHS for what jobs download themselves: rustup toolchains,
  # node binaries, and a Playwright Chromium (hence chromium's own inputs).
  programs.nix-ld.libraries = with pkgs; [
    stdenv.cc.cc zlib openssl
    # What Playwright's downloaded Chromium (headless shell) dlopens.
    glib nss nspr dbus at-spi2-atk at-spi2-core cups libdrm mesa libgbm expat
    libxkbcommon alsa-lib pango cairo gtk3 systemd fontconfig freetype
    xorg.libX11 xorg.libXcomposite xorg.libXdamage xorg.libXext xorg.libXfixes
    xorg.libXrandr xorg.libxcb xorg.libXcursor xorg.libXi xorg.libXrender xorg.libXtst
  ];

  environment.systemPackages = with pkgs; [ attic-client curl chromium ];
  # Bazel runs actions with an empty environment; envfs cannot resolve a
  # command for a caller with no PATH. Forward the client's PATH into actions.
  environment.etc."bazel.bazelrc".text = "build --action_env=PATH\n";
  # Real symlinks in /bin and /usr/bin for tools that scripts and build
  # systems address by absolute path or with a scrubbed environment. Bazel
  # (cel-cxx builds cel-cpp with it) execs /bin/bash and runs its actions
  # with no PATH at all, which rules out envfs; test configs hardcode
  # /usr/bin/google-chrome.
  system.activationScripts.fhsBin = let
    fhs = pkgs.buildEnv {
      name = "fhs-bin";
      paths = with pkgs; [ bash coreutils gnused gnugrep gawk findutils diffutils gnutar gzip which python3 ];
      pathsToLink = [ "/bin" ];
    };
  in ''
    mkdir -p /bin /usr/bin
    for f in ${fhs}/bin/*; do ln -sfn "$f" "/usr/bin/$(basename "$f")"; done
    # nixpkgs' bash has a built-in default PATH of /no-such-path, so with an
    # empty environment it would find nothing even in /usr/bin.
    ln -sfn ${pkgs.writeShellScript "bash-fhs" ''
      # bash itself sets PATH=/no-such-path when it starts with none.
      case ":''${PATH:-}:" in
        *:/no-such-path:*|::) PATH=/usr/bin:/bin ;;
        *) PATH="$PATH:/usr/bin:/bin" ;;
      esac
      export PATH
      exec ${pkgs.bash}/bin/bash "$@"
    ''} /bin/bash
    ln -sfn ${pkgs.chromium}/bin/chromium /usr/bin/google-chrome
  '';

  # rig writes the env file after the VM is up; the path unit waits for it.
  systemd.paths.ci-runner = {
    wantedBy = [ "multi-user.target" ];
    pathConfig.PathExists = "/run/rig/env";
  };

  systemd.services.ci-runner = {
    description = "Run one CI job, then power off";
    wants = [ "network-online.target" ] ++ relayUnits;
    after = [ "network-online.target" ] ++ relayUnits;
    path = with pkgs; [ bashInteractive coreutils git gnutar gzip curl nix attic-client github-runner ];
    environment = {
      HOME = "/var/lib/runner";
      RUNNER_ROOT = "/var/lib/runner/root";
      # Node for JavaScript actions ships inside the runner package.
      RUNNER_ALLOW_RUNASROOT = "0";
      # Before any step of a job: on a trusted pool, refuse what is not main
      # or a tag of a trusted repository (job-gate.sh). Lets all through
      # without CI_TRUSTED_REPOS.
      ACTIONS_RUNNER_HOOK_JOB_STARTED = "${./job-gate.sh}";
    };
    serviceConfig = {
      Type = "oneshot";
      User = "runner";
      Group = "users";
      WorkingDirectory = "/var/lib/runner";
      EnvironmentFile = "/run/rig/env";   # read by systemd as root; the file is 0600
      TimeoutStartSec = "infinity";
      # Whatever happened, this VM has done its one job. Its journal goes to
      # the console first, so `rig logs <vm>` on the host still shows it.
      ExecStopPost = "+${pkgs.writeShellScript "ci-runner-done" ''
        ${pkgs.systemd}/bin/journalctl -u ci-runner --no-pager -o cat > /dev/console 2>&1 || true
        ${pkgs.systemd}/bin/systemctl poweroff
      ''}";
    };
    script = ''
      set -euo pipefail
      # The cache is optional: a job without it is slower, not broken. Attic
      # advertises 127.0.0.1:17080 as its endpoint, which is right here too.
      if [ -n "''${ATTIC_TOKEN:-}" ]; then
        for _ in $(seq 1 12); do
          if attic login ci "$ATTIC_URL" "$ATTIC_TOKEN" 2>/dev/null && attic use ci:mono; then
            break
          fi
          sleep 5
        done
        attic cache info ci:mono >/dev/null 2>&1 || echo "attic: cache not configured, continuing"
      fi
      mkdir -p "$RUNNER_ROOT" _work
      exec run.sh --jitconfig "$JIT_CONFIG"
    '';
  };

  system.stateVersion = lib.mkDefault "26.05";
}
