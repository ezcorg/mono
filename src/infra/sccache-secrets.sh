#!/usr/bin/env bash
# Generate the sccache store's secrets into secrets/pengutron.yaml:
#
#   garage/env       GARAGE_RPC_SECRET, Garage's node secret
#   sccache/key-ro   the Garage key the untrusted pools read with
#   sccache/key-rw   the Garage key the trusted pools write with
#
# Run it where sops can decrypt the file (on macOS, export SOPS_AGE_KEY_FILE
# first; see README.md), then deploy pengutron and run ./sccache-setup.sh
# there. A secret that is already set is left alone: Garage holds a copy of
# each key, and the two must agree.
set -euo pipefail
cd "$(dirname "$0")"
file=secrets/pengutron.yaml

# Fail here, before anything is written, if this machine cannot decrypt.
sops -d "$file" >/dev/null

has() { sops -d --extract "$1" "$file" >/dev/null 2>&1; }
put() { # put <path> <value>; sops set takes the value as JSON
  if has "$1"; then
    echo "$1: already set, left alone"
  else
    sops set "$file" "$1" "$(jq -n --arg v "$2" '$v')"
    echo "$1: generated"
  fi
}
# Garage's own format: an access key ID is GK and 24 hex digits, a secret 64.
garage_key() {
  printf 'AWS_ACCESS_KEY_ID=GK%s\nAWS_SECRET_ACCESS_KEY=%s\n' "$(openssl rand -hex 12)" "$(openssl rand -hex 32)"
}

put '["garage"]["env"]' "GARAGE_RPC_SECRET=$(openssl rand -hex 32)"
put '["sccache"]["key-ro"]' "$(garage_key)"
put '["sccache"]["key-rw"]' "$(garage_key)"
