# Build the ci-macos Tart image from Cirrus's Tahoe base. Run on the Mac host
# as the pool user. Idempotent: rebuilds from the base every time.
#
#   nix run .#ci-macos-image            # from src/infra, on galatron
#
# What goes in: Determinate Nix (multi-user, admin trusted), the GitHub
# actions runner, attic, ci-run.sh, our SSH key; password login off; sleep off.
# What stays out: toolchains. Jobs get those from each project's flake.
#
# Env (all optional):
#   BASE        image to start from (default tahoe-base)
#   IMAGE       alias to produce (default ci-macos)
#   GUEST_KEY   SSH key whose public half the image will trust (default ~/.ssh/ci-guest; created if missing)
#   GUEST_DIR   directory holding guest-run.sh (default: alongside this script's source)

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

sshp bash -s <<REMOTE
set -euo pipefail
echo "--- ssh: key only"
mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat ~/ci-guest.pub >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && rm ~/ci-guest.pub
sudo sed -i '' -E 's/^#?PasswordAuthentication .*/PasswordAuthentication no/; s/^#?KbdInteractiveAuthentication .*/KbdInteractiveAuthentication no/' /etc/ssh/sshd_config
chmod +x ~/ci-run.sh
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
echo "--- random admin password (ssh is key-only; sudo stays passwordless)"
sudo dscl . -passwd /Users/admin admin "\$(openssl rand -base64 24)"
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
