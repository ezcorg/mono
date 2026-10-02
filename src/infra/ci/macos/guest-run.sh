#!/bin/bash
# Inside the VM: one job, then power off. build-image.sh installs this as
# ~/ci-run.sh; the orchestrator writes ~/.ci-env and starts it over SSH.
set -uo pipefail
# shellcheck disable=SC1090
. "$HOME/.ci-env"
export PATH="/nix/var/nix/profiles/default/bin:$HOME/.nix-profile/bin:/opt/homebrew/bin:$PATH"

if [ -n "${ATTIC_TOKEN:-}" ]; then
  for _ in $(seq 1 24); do
    if attic login ci "$ATTIC_URL" "$ATTIC_TOKEN" 2>/dev/null && attic use ci:mono; then break; fi
    sleep 5
  done
  # attic use writes the server's public endpoint; we reach it via the tunnel.
  if attic cache info ci:mono >/dev/null 2>&1; then
    host=$(echo "$ATTIC_URL" | sed -E 's#^https?://##; s#/.*##; s#:.*##')
    sed -i '' -E "s#https?://[^/ ]+(/mono)#$ATTIC_URL\\1#g" "$HOME/.config/nix/nix.conf"
    sed -i '' -E "s#^machine [^ ]+#machine $host#" "$HOME/.config/nix/netrc"
  else
    echo "attic: cache not configured, continuing"
  fi
fi

cd "$HOME/actions-runner" && ./run.sh --jitconfig "$JIT_CONFIG"
sudo shutdown -h now
