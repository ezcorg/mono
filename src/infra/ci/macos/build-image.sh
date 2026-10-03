# Build the ci-macos Tart image from Cirrus's Tahoe base. Run on the Mac host
# as the pool user. Idempotent: rebuilds from the base every time.
#
#   nix run .#ci-macos-image            # from src/infra, on galatron
#
# What goes in: Determinate Nix (multi-user, admin trusted), the GitHub
# actions runner, attic, ci-run.sh and the LaunchAgent that starts it in
# admin's login session (automatic login, with a random password), our SSH
# key, Apple's Developer ID G2 intermediate and root in the System keychain;
# password login over SSH off; sleep off.
# What stays out: toolchains. Jobs get those from each project's flake.
#
# Env (all optional):
#   BASE        image to start from (default tahoe-base)
#   IMAGE       alias to produce (default ci-macos)
#   GUEST_KEY   SSH key whose public half the image will trust (default ~/.ssh/ci-guest; created if missing)
#   GUEST_DIR   directory holding guest-run.sh and the certificates (default: alongside this script's source)

base=${BASE:-tahoe-base}
image=${IMAGE:-ci-macos}
key=${GUEST_KEY:-$HOME/.ssh/ci-guest}
guest_dir=${GUEST_DIR:-@guestDir@}
work="${image}-build"

log() { echo "[image] $*"; }

[ -f "$key" ] || { log "creating $key"; ssh-keygen -q -t ed25519 -N "" -C "ci-guest@$(hostname -s)" -f "$key"; }
[ -f "$guest_dir/guest-run.sh" ] || { echo "guest-run.sh not found in $guest_dir" >&2; exit 1; }

runner_ver=$(curl -sSf https://api.github.com/repos/actions/runner/releases/latest | jq -r '.tag_name | ltrimstr("v")')
log "runner version $runner_ver"

tart delete "$work" >/dev/null 2>&1 || true
tart clone "$base" "$work"
tart set "$work" --cpu 4 --memory 8192
runlog="${TMPDIR:-/tmp}/$work.tart.log"
tart run "$work" --no-graphics --no-audio >"$runlog" 2>&1 &
run_pid=$!
trap 'kill $run_pid 2>/dev/null; wait $run_pid 2>/dev/null; tart delete "$work" >/dev/null 2>&1' EXIT

# Cirrus base images: user admin, password admin, passwordless sudo.
sshopts=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR
         -o PreferredAuthentications=password -o PubkeyAuthentication=no -o ConnectTimeout=10)
sshp() { sshpass -p admin ssh "${sshopts[@]}" "admin@$ip" "$@"; }
# Files go over ssh's stdin; scp's password handling under sshpass is unreliable here.
putf() { sshp "cat > $2" < "$1"; }
ip=""
for _ in $(seq 1 60); do
  ip=$(tart ip "$work" 2>/dev/null || true)
  case "$ip" in
    *.*.*.*) if sshp true 2>"$work.ssh-err"; then break; fi ;;
  esac
  ip=""; sleep 5
done
if [ -z "$ip" ]; then
  echo "VM never came up; last ssh error:" >&2; cat "$work.ssh-err" >&2 2>/dev/null || true
  echo "tart run said:" >&2; cat "$runlog" >&2 2>/dev/null || true
  echo "tart list:" >&2; tart list >&2 2>/dev/null || true
  exit 1
fi
rm -f "$work.ssh-err"
log "builder at $ip"

putf "$guest_dir/guest-run.sh" ci-run.sh
putf "$key.pub" ci-guest.pub
for cert in DeveloperIDG2CA.cer AppleIncRootCertificate.cer; do putf "$guest_dir/$cert" "$cert"; done

sshp bash -s <<REMOTE
set -euo pipefail
echo "--- ssh: key only"
mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat ~/ci-guest.pub >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && rm ~/ci-guest.pub
sudo sed -i '' -E 's/^#?PasswordAuthentication .*/PasswordAuthentication no/; s/^#?KbdInteractiveAuthentication .*/KbdInteractiveAuthentication no/' /etc/ssh/sshd_config
chmod +x ~/ci-run.sh
echo "--- Apple's Developer ID chain, in the System keychain"
# codesign completes a signer's chain from keychains, and this image has
# Apple's root only in the system's root store. Outside a login session (a
# runner started over SSH) codesign does not take the chain from a job's own
# keychain either: "unable to build chain to self-signed root" and
# errSecInternalComponent. From the System keychain it always does, in or out
# of a session; Cirrus's Xcode images do the same.
#   DeveloperIDG2CA.cer      SHA-256 f16cd3c54c7f83cea4bf1a3e6a0819c8aaa8e4a1528fd144715f350643d2df3a
#   AppleIncRootCertificate  SHA-256 b0b1730ecbc7ff4505142c49f1295e6eda6bcaed7e2c68c5be91b5a11001f024
# (apple.com/certificateauthority; the root trusts nothing new, macOS already does)
sudo security add-certificates -k /Library/Keychains/System.keychain ~/DeveloperIDG2CA.cer ~/AppleIncRootCertificate.cer
rm ~/DeveloperIDG2CA.cer ~/AppleIncRootCertificate.cer
echo "--- no sleep, no updates"
sudo pmset -a sleep 0 disksleep 0 displaysleep 0
sudo softwareupdate --schedule off >/dev/null 2>&1 || true
echo "--- Determinate Nix"
curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix \
  | sh -s -- install --determinate --no-confirm --extra-conf "trusted-users = root admin" >/dev/null
export PATH=/nix/var/nix/profiles/default/bin:\$PATH
nix --version
echo "--- attic client"
nix profile add nixpkgs#attic-client >/dev/null
echo "--- actions runner $runner_ver"
mkdir -p ~/actions-runner && cd ~/actions-runner
curl -sSfL -o runner.tgz "https://github.com/actions/runner/releases/download/v$runner_ver/actions-runner-osx-arm64-$runner_ver.tar.gz"
tar xzf runner.tgz && rm runner.tgz
echo "--- random admin password, kept logging in (ssh is key-only; sudo stays passwordless)"
# The base image logs admin in automatically with the password it was built
# with (admin). The account, its login keychain and the automatic login all
# take the new one, or the VM would stay at the login window with no session.
pw=\$(openssl rand -hex 24)
sudo dscl . -passwd /Users/admin admin "\$pw"
security set-keychain-password -o admin -p "\$pw" ~/Library/Keychains/login.keychain-db
sudo sysadminctl -autologin set -userName admin -password "\$pw"
echo "--- the runner, started in the login session"
# Jobs then run as a logged-in user's work does: the user's keychain search
# list for codesign, the GUI for UI tests and simulators. The agent waits for
# the orchestrator's ~/.ci-env, which arrives whole (written, then renamed).
mkdir -p ~/Library/LaunchAgents
cat > ~/Library/LaunchAgents/org.ezcorg.ci-runner.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>org.ezcorg.ci-runner</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>-c</string>
    <string>until [ -s /Users/admin/.ci-env ]; do sleep 1; done; exec /Users/admin/ci-run.sh</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>HOME</key><string>/Users/admin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>StandardOutPath</key><string>/Users/admin/ci-run.log</string>
  <key>StandardErrorPath</key><string>/Users/admin/ci-run.log</string>
</dict></plist>
PLIST
plutil -lint ~/Library/LaunchAgents/org.ezcorg.ci-runner.plist
echo "--- done"
REMOTE

# Stop from the host: a shutdown issued over ssh ends the session with a
# non-zero status, which would abort this script before the rename.
tart stop "$work"
wait "$run_pid" 2>/dev/null || true
trap - EXIT
tart delete "$image" >/dev/null 2>&1 || true
tart rename "$work" "$image"
log "$image ready:"
tart list | grep -E "^local +$image "
