#!/usr/bin/env bash
# Deploy a build host from this directory: copy src/infra to the host and
# switch there. The hosts keep no checkout of the monorepo; this directory is
# all they need, and nix reads it as a plain path (no git tree copy).
#
#   src/infra/deploy.sh pengutron
#   src/infra/deploy.sh galatron
#
# Asks for the host's sudo password on the terminal.
set -euo pipefail
host=${1:?usage: deploy.sh <pengutron|galatron>}
here=$(cd "$(dirname "$0")" && pwd)
case "$host" in
  pengutron) ssh_to="pengutron";      switch="sudo nixos-rebuild switch --flake path:\$HOME/infra#pengutron" ;;
  galatron)  ssh_to="theo@galatron";  switch="sudo darwin-rebuild switch --flake path:\$HOME/infra#galatron" ;;
  *) echo "unknown host: $host" >&2; exit 2 ;;
esac
rsync -a --delete --exclude '.direnv' "$here/" "$ssh_to:infra/"
exec ssh -t "$ssh_to" "$switch"
