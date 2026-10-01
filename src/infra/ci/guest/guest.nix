# One job, then power off. The host injects /run/rig/env (tmpfs) after boot:
#   JIT_CONFIG    a single-use GitHub runner registration
#   ATTIC_URL     the cache, tunnelled in over vsock by the orchestrator
#   ATTIC_TOKEN   optional; pull, or pull+push on the trusted pool
{ pkgs, lib, ... }:

{
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
  # /bin and /usr/bin that resolve any command on the caller's PATH. Bazel
  # (cel-cxx builds cel-cpp with it) execs /bin/bash and then runs its actions
  # with a scrubbed PATH of /bin:/usr/bin, so cp, sed and friends must exist
  # there; test configs hardcode /usr/bin/google-chrome.
  services.envfs.enable = true;
  # envfs resolves from the caller's PATH; Bazel's actions run with PATH
  # scrubbed to /bin:/usr/bin, so the basics must exist as fallbacks.
  services.envfs.extraFallbackPathCommands = ''
    for d in ${lib.concatMapStringsSep " " (p: "${p}/bin") (with pkgs; [
      bash coreutils gnused gnugrep gawk findutils diffutils gnutar gzip which python3
    ])}; do
      for f in "$d"/*; do ln -sf "$f" "$out/$(basename "$f")"; done
    done
    ln -sf ${pkgs.chromium}/bin/chromium $out/google-chrome
  '';

  # rig writes the env file after the VM is up; the path unit waits for it.
  systemd.paths.ci-runner = {
    wantedBy = [ "multi-user.target" ];
    pathConfig.PathExists = "/run/rig/env";
  };

  systemd.services.ci-runner = {
    description = "Run one CI job, then power off";
    wants = [ "network-online.target" ];
    after = [ "network-online.target" ];
    path = with pkgs; [ bashInteractive coreutils git gnutar gzip curl nix attic-client github-runner ];
    environment = {
      HOME = "/var/lib/runner";
      RUNNER_ROOT = "/var/lib/runner/root";
      # Node for JavaScript actions ships inside the runner package.
      RUNNER_ALLOW_RUNASROOT = "0";
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
      # The host opens the cache tunnel a few seconds after injecting the
      # env file, so wait for it rather than racing it.
      if [ -n "''${ATTIC_TOKEN:-}" ]; then
        for _ in $(seq 1 24); do
          if attic login ci "$ATTIC_URL" "$ATTIC_TOKEN" 2>/dev/null && attic use ci:mono; then
            break
          fi
          sleep 5
        done
        # `attic use` writes the server's public endpoint; this guest reaches
        # the cache only through the tunnel, so point nix at that instead.
        if attic cache info ci:mono >/dev/null 2>&1; then
          host=$(echo "$ATTIC_URL" | sed -E 's#^https?://##; s#/.*##; s#:.*##')
          sed -i -E "s#https?://[^/ ]+(/mono)#$ATTIC_URL\\1#g" "$HOME/.config/nix/nix.conf"
          sed -i -E "s#^machine [^ ]+#machine $host#" "$HOME/.config/nix/netrc"
        else
          echo "attic: cache not configured, continuing"
        fi
      fi
      mkdir -p "$RUNNER_ROOT" _work
      exec run.sh --jitconfig "$JIT_CONFIG"
    '';
  };

  system.stateVersion = lib.mkDefault "26.05";
}
