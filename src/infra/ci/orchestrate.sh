# One CI pool: keep exactly one fresh rig VM registered as a single-use
# ("just-in-time") GitHub runner. When it finishes a job it powers itself off;
# we delete it and make the next one. Run by systemd (modules/ci-pools.nix),
# which supplies the environment and credentials below.
#
#   POOL, ORG, LABELS, IMAGE, CPUS, MEMORY, DISK, MAX_JOB_SECONDS, SCCACHE_RW_MODE
#   $CREDENTIALS_DIRECTORY/github-token        creates JIT configs (org permission: self-hosted runners, write)
#   $CREDENTIALS_DIRECTORY/attic-token         optional; pull, or pull+push for trusted pools
#   $CREDENTIALS_DIRECTORY/sccache-key         optional; AWS_* lines for the sccache store, read-only or read-write
#   $RUNTIME_DIRECTORY                         per-VM manifest and env files (tmpfs)
#
# Attic (127.0.0.1:17080) and the sccache store (127.0.0.1:17090) are already in
# every guest: the host relays them over vsock (modules/ci-pools.nix).
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
      "https://api.github.com/orgs/$ORG/actions/runners/generate-jitconfig" \
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
      echo "ATTIC_URL=http://127.0.0.1:17080"
      [ -n "$attic_token" ] && echo "ATTIC_TOKEN=$attic_token"
      # The guest's environment is the runner's, so jobs see these; a job
      # opts in with RUSTC_WRAPPER=sccache.
      if [ -r "$CREDENTIALS_DIRECTORY/sccache-key" ]; then
        echo "SCCACHE_BUCKET=sccache"
        echo "SCCACHE_ENDPOINT=http://127.0.0.1:17090"
        echo "SCCACHE_REGION=garage"
        echo "SCCACHE_S3_USE_SSL=false"
        echo "SCCACHE_S3_RW_MODE=$SCCACHE_RW_MODE"
        cat "$CREDENTIALS_DIRECTORY/sccache-key"
      fi
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

  log "$vm finished; deleting"
  rig delete -f "$yaml" || log "warning: could not delete $vm"
  rm -f "$envf" "$yaml"
  # The guest powers off as soon as its job ends, sometimes before the
  # runner's own deregistration reaches GitHub.
  delete_registration "$vm"
done
