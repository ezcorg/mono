#!/usr/bin/env bash
# The trusted pools' gate, a GitHub runner job-started hook
# (ACTIONS_RUNNER_HOOK_JOB_STARTED): it runs once a job is assigned, before
# any of its steps, and fails the job unless the job comes from a repository
# in CI_TRUSTED_REPOS and from main or a tag: a push to main, a manual run of
# main, or a pushed tag. No pull request passes, whoever opened it. Any
# workflow in the org can ask for the trusted labels (GitHub Free has one
# runner group); this keeps a trusted VM's cache credentials to the code
# allowed to write the caches. With CI_TRUSTED_REPOS unset (the pull-request
# pools) every job passes.
#
# Linux bakes it into the image (guest.nix); galatron's orchestrator copies
# it into each macOS VM. Keep it to what macOS's bash 3.2 runs.
set -euo pipefail
[ -n "${CI_TRUSTED_REPOS:-}" ] || exit 0

repo=${GITHUB_REPOSITORY:-} event=${GITHUB_EVENT_NAME:-} ref=${GITHUB_REF:-}
refuse() {
  echo "::error::A trusted pool runs $CI_TRUSTED_REPOS from main (pushes and manual runs) and tags; not $event on $ref in $repo. Use the pull-request pools' labels."
  exit 1
}
case ",$CI_TRUSTED_REPOS," in *",$repo,"*) ;; *) refuse ;; esac
case "$event:$ref" in
  push:refs/heads/main | workflow_dispatch:refs/heads/main | push:refs/tags/*) ;;
  *) refuse ;;
esac
echo "trusted pool: $event on $ref in $repo"
