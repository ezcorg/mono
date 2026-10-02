# One CI pool: keep exactly one fresh rig VM registered as a single-use
# ("just-in-time") GitHub runner. When it finishes a job it powers itself off;
# we delete it and make the next one. Run by systemd (modules/ci-pools.nix),
# which supplies the environment and credentials below.
#
#   POOL, REPO, LABELS, IMAGE, CPUS, MEMORY, DISK, MAX_JOB_SECONDS, ATTIC_GUEST_PORT
#   $CREDENTIALS_DIRECTORY/github-token        creates JIT configs (repo admin scope)
#   $CREDENTIALS_DIRECTORY/attic-token         optional; pull, or pull+push for trusted pools
#   $RUNTIME_DIRECTORY                         per-VM manifest and env files (tmpfs)
#
# The only GitHub-specific line is the generate-jitconfig call. Another CI
# system means another way to get a one-job credential into the env file.

vm_status() {
  rig status --json | jq -r --arg n "$1" '.instances[] | select(.name == $n) | .status'
}

log() { echo "[$POOL] $*"; }

gh_token=$(<"$CREDENTIALS_DIRECTORY/github-token")
attic_token=""
if [ -r "$CREDENTIALS_DIRECTORY/attic-token" ]; then
  attic_token=$(<"$CREDENTIALS_DIRECTORY/attic-token")
fi

labels_json=$(printf '%s' "$LABELS" | jq -R 'split(",")')

gh_api() { # gh_api <method> <path> [curl args...]
  local m=$1 path=$2; shift 2
  curl -sSf -X "$m" -H "Authorization: Bearer $gh_token" -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" "https://api.github.com/repos/$REPO$path" "$@"
}
runner_busy() { # true once GitHub has handed this runner a job
  [ "$(gh_api GET "/actions/runners?name=$1" 2>/dev/null | jq -r '.runners[0].busy // false')" = "true" ]
}
delete_registration() { # a runner that never connected, or was killed, stays listed
  for id in $(gh_api GET "/actions/runners?name=$1" 2>/dev/null | jq -r '.runners[] | select(.busy | not) | .id'); do
    gh_api DELETE "/actions/runners/$id" >/dev/null 2>&1 || true
  done
}

# A restart mid-job leaves a VM behind. Each of ours is named POOL-<epoch>;
# anything matching that which is not the one we are about to make is stale.
for stale in $(rig status --json | jq -r --arg p "$POOL" '.instances[].name | select(test("^" + $p + "-[0-9]+$"))'); do
  log "removing stale $stale"
  rig stop "$stale" >/dev/null 2>&1 || true
  rig rm "$stale" >/dev/null 2>&1 || log "warning: could not remove $stale"
  delete_registration "$stale"
done

while :; do
  vm="${POOL}-$(date +%s)"
  envf="$RUNTIME_DIRECTORY/$vm.env"
  yaml="$RUNTIME_DIRECTORY/$vm.yaml"

  # A registration good for exactly one job. The runner deregisters itself
  # when the job ends; if the VM dies first, GitHub expires it on its own.
  if ! jit=$(curl -sSf -X POST \
      -H "Authorization: Bearer $gh_token" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "https://api.github.com/repos/$REPO/actions/runners/generate-jitconfig" \
      -d "$(jq -cn --arg name "$vm" --argjson labels "$labels_json" \
            '{name: $name, runner_group_id: 1, labels: $labels, work_folder: "_work"}')" \
      | jq -er .encoded_jit_config); then
    log "could not get a JIT runner config; retrying in 60s"
    sleep 60
    continue
  fi

  (
    umask 077
    {
      echo "JIT_CONFIG=$jit"
      echo "ATTIC_URL=http://127.0.0.1:$ATTIC_GUEST_PORT"
      [ -n "$attic_token" ] && echo "ATTIC_TOKEN=$attic_token"
    } > "$envf"
    cat > "$yaml" <<YAML
guest:
  name: $vm
  image: $IMAGE
  cpus: $CPUS
  memory: $MEMORY
  disk: $DISK
  env_file: $envf
YAML
  )

  log "starting $vm"
  if ! rig apply -f "$yaml" --start; then
    log "rig apply failed; cleaning up and retrying in 30s"
    rig delete -f "$yaml" || true
    rm -f "$envf" "$yaml"
    sleep 30
    continue
  fi

  # Attic, over vsock: the guest's 127.0.0.1:$ATTIC_GUEST_PORT becomes the
  # host's 8080. The guest's NIC cannot reach the host, so this is the only
  # path to the cache. rig's host-side vsock listener is keyed on the guest
  # port, which is why each pool has its own.
  fwd_pid=""
  for _ in $(seq 1 12); do
    rig forward "$vm" "$ATTIC_GUEST_PORT" --to-guest --host-port 8080 &
    fwd_pid=$!
    sleep 5
    if kill -0 "$fwd_pid" 2>/dev/null; then break; fi
    fwd_pid=""
  done
  [ -n "$fwd_pid" ] || log "warning: attic forward to $vm did not come up; job runs without the cache"

  # The job clock starts when GitHub marks the runner busy; an idle warm VM
  # waits as long as it takes.
  deadline=""
  tick=0
  while [ "$(vm_status "$vm")" = "Running" ]; do
    if [ -z "$deadline" ] && [ $((tick % 6)) -eq 0 ] && runner_busy "$vm"; then
      deadline=$((SECONDS + MAX_JOB_SECONDS))
      log "$vm picked up a job"
    fi
    if [ -n "$deadline" ] && [ "$SECONDS" -ge "$deadline" ]; then
      log "$vm exceeded ${MAX_JOB_SECONDS}s; stopping it"
      rig stop "$vm" || true
      delete_registration "$vm"
      break
    fi
    tick=$((tick + 1))
    sleep 5
  done

  # rig forward tears down on Ctrl-C (SIGINT), not SIGTERM. Give it a moment,
  # then insist; a wait on a process that ignores the signal never returns.
  if [ -n "$fwd_pid" ]; then
    kill -INT "$fwd_pid" 2>/dev/null || true
    for _ in $(seq 1 10); do kill -0 "$fwd_pid" 2>/dev/null || break; sleep 1; done
    kill -KILL "$fwd_pid" 2>/dev/null || true
    wait "$fwd_pid" 2>/dev/null || true
  fi
  log "$vm finished; deleting"
  rig delete -f "$yaml" || log "warning: could not delete $vm"
  rm -f "$envf" "$yaml"
  # The guest powers off as soon as its job ends, sometimes before the
  # runner's own deregistration reaches GitHub.
  delete_registration "$vm"
done
