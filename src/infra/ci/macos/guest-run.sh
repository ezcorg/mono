#!/bin/bash
# Inside the VM: one job, then power off. build-image.sh installs this as
# ~/ci-run.sh. The orchestrator writes ~/.ci-env, and the image's LaunchAgent
# (org.ezcorg.ci-runner) starts this in admin's login session; without one,
# the orchestrator starts it over SSH.
set -uo pipefail
# Once per VM, whichever starts it first.
mkdir "$HOME/.ci-run.lock" 2>/dev/null || exit 0
# shellcheck disable=SC1090
. "$HOME/.ci-env"
export PATH="/nix/var/nix/profiles/default/bin:$HOME/.nix-profile/bin:/opt/homebrew/bin:$PATH"

if [ -n "${ATTIC_TOKEN:-}" ]; then
  for _ in $(seq 1 24); do
    if attic login ci "$ATTIC_URL" "$ATTIC_TOKEN" 2>/dev/null && attic use ci:mono; then break; fi
    sleep 5
  done
  # Attic advertises 127.0.0.1:17080 as its endpoint, which is right here too.
  attic cache info ci:mono >/dev/null 2>&1 || echo "attic: cache not configured, continuing"
fi

cd "$HOME/actions-runner" && ./run.sh --jitconfig "$JIT_CONFIG"
sudo shutdown -h now
