# One macOS CI pool: keep exactly one fresh Tart VM registered as a single-use
# GitHub runner. The VM runs one job, shuts itself down, and is deleted; then
# we make the next one. Run by launchd as the logged-in user
# (modules/darwin/ci-pools-tart.nix), which supplies:
#
#   POOL, ORG, LABELS, IMAGE, CPUS, MEMORY (MiB), MAX_JOB_SECONDS
#   ATTIC_HOST_URL      Attic as this host reaches it; the VM sees it as 127.0.0.1:8080
#   GUEST_KEY           SSH private key whose public half the image trusts
#   GITHUB_TOKEN_FILE   creates JIT configs (org permission: self-hosted runners, write)
#   ATTIC_TOKEN_FILE    optional; pull, or pull+push for trusted pools
#   STATE_DIR           per-pool scratch (env files)
#
# Same shape as ci/orchestrate.sh on Linux; only "make a VM" and "reach it"
# differ. The GitHub-specific part is the one generate-jitconfig call.

log() { echo "[$(date +%H:%M:%S) $POOL] $*"; }

gh_token=$(<"$GITHUB_TOKEN_FILE")
attic_token=""
[ -n "${ATTIC_TOKEN_FILE:-}" ] && [ -r "$ATTIC_TOKEN_FILE" ] && attic_token=$(<"$ATTIC_TOKEN_FILE")
labels_json=$(printf '%s' "$LABELS" | jq -R 'split(",")')
mkdir -p "$STATE_DIR"
attic_host_port=$(echo "$ATTIC_HOST_URL" | sed -E 's#^https?://##; s#/.*##')

ssh_vm() { # ssh_vm <ip> <command...>
  local ip=$1; shift
  ssh -i "$GUEST_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o LogLevel=ERROR -o ConnectTimeout=10 "admin@$ip" "$@"
}

gh_api() { # gh_api <method> <path> [curl args...]
  local m=$1 path=$2; shift 2
  curl -sSf -X "$m" -H "Authorization: Bearer $gh_token" -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" "https://api.github.com/orgs/$ORG$path" "$@"
}
runner_busy() { # true once GitHub has handed this runner a job
  [ "$(gh_api GET "/actions/runners?name=$1" 2>/dev/null | jq -r '.runners[0].busy // false')" = "true" ]
}
delete_registration() { # a runner that never connected, or was killed, stays listed
  for id in $(gh_api GET "/actions/runners?name=$1" 2>/dev/null | jq -r '.runners[] | select(.busy | not) | .id'); do
    gh_api DELETE "/actions/runners/$id" >/dev/null 2>&1 || true
  done
}

# Whatever a previous instance of this pool left behind.
for stale in $(tart list -q 2>/dev/null | grep -E "^${POOL}-[0-9]+$" || true); do
  log "removing stale $stale"
  tart stop "$stale" >/dev/null 2>&1 || true
  tart delete "$stale" >/dev/null 2>&1 || log "warning: could not delete $stale"
  delete_registration "$stale"
done

while :; do
  vm="${POOL}-$(date +%s)"

  if ! jit=$(curl -sSf -X POST \
      -H "Authorization: Bearer $gh_token" -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "https://api.github.com/orgs/$ORG/actions/runners/generate-jitconfig" \
      -d "$(jq -cn --arg name "$vm" --argjson labels "$labels_json" \
            '{name: $name, runner_group_id: 1, labels: $labels, work_folder: "_work"}')" \
      | jq -er .encoded_jit_config); then
    log "could not get a JIT runner config; retrying in 60s"
    sleep 60
    continue
  fi

  log "starting $vm"
  if ! tart clone "$IMAGE" "$vm" || ! tart set "$vm" --cpu "$CPUS" --memory "$MEMORY"; then
    log "clone failed; retrying in 60s"
    tart delete "$vm" >/dev/null 2>&1 || true
    delete_registration "$vm"
    sleep 60
    continue
  fi
  tart run "$vm" --no-graphics --no-audio >/dev/null 2>&1 &
  run_pid=$!

  ip=""
  for _ in $(seq 1 36); do
    ip=$(tart ip "$vm" 2>/dev/null || true)
    [ -n "$ip" ] && ssh_vm "$ip" true 2>/dev/null && break
    ip=""; sleep 5
  done
  if [ -z "$ip" ]; then
    log "$vm never became reachable; discarding"
    kill "$run_pid" 2>/dev/null || true; wait "$run_pid" 2>/dev/null || true
    tart delete "$vm" >/dev/null 2>&1 || true
    delete_registration "$vm"
    sleep 15
    continue
  fi
  log "$vm up at $ip"

  # Attic, over the SSH session: the guest's 127.0.0.1:8080 becomes Attic as
  # this host sees it. Nothing is opened on the host's own interfaces.
  ssh -i "$GUEST_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
      -o ExitOnForwardFailure=yes -N -R "8080:$attic_host_port" "admin@$ip" &
  fwd_pid=$!

  {
    echo "JIT_CONFIG=$jit"
    echo "ATTIC_URL=http://127.0.0.1:8080"
    [ -n "$attic_token" ] && echo "ATTIC_TOKEN=$attic_token"
  } | ssh_vm "$ip" 'umask 077; cat > ~/.ci-env'
  ssh_vm "$ip" 'nohup ~/ci-run.sh > ~/ci-run.log 2>&1 &'

  # The guest shuts itself down after its one job; tart run then exits. The
  # job clock starts when GitHub marks the runner busy; idle waits are free.
  deadline=""
  tick=0
  while kill -0 "$run_pid" 2>/dev/null; do
    if [ -z "$deadline" ] && [ $((tick % 6)) -eq 0 ] && runner_busy "$vm"; then
      deadline=$((SECONDS + MAX_JOB_SECONDS))
      log "$vm picked up a job"
    fi
    if [ -n "$deadline" ] && [ "$SECONDS" -ge "$deadline" ]; then
      log "$vm exceeded ${MAX_JOB_SECONDS}s; stopping it"
      tart stop "$vm" >/dev/null 2>&1 || kill "$run_pid" 2>/dev/null || true
      delete_registration "$vm"
      break
    fi
    tick=$((tick + 1))
    sleep 5
  done
  wait "$run_pid" 2>/dev/null || true
  kill "$fwd_pid" 2>/dev/null || true; wait "$fwd_pid" 2>/dev/null || true

  log "$vm finished; deleting"
  tart delete "$vm" >/dev/null 2>&1 || log "warning: could not delete $vm"
  # The guest powers off as soon as its job ends, sometimes before the
  # runner's own deregistration reaches GitHub.
  delete_registration "$vm"
done
