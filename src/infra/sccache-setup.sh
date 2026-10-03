#!/usr/bin/env bash
# Set up the sccache store on pengutron, once, after the deploy that starts
# Garage (modules/sccache-store.nix): a one-node layout, the `sccache` bucket
# and its quota, the two keys sops-nix decrypted from sccache-secrets.sh's
# output, their permissions, and a rule expiring objects 30 days after they
# were written (Garage evicts nothing itself, and at its quota the cache would
# only stop growing). Safe to run again: what exists is left as it is.
#
#   ~/infra/sccache-setup.sh            # on pengutron, as a user who can sudo
set -euo pipefail
secrets=${SECRETS:-/run/secrets}   # where sops-nix puts them
endpoint=http://127.0.0.1:17090

# The CLI reads the RPC secret from a root-only file; sudo runs the real one.
# shellcheck disable=SC2032,SC2033
garage() { sudo garage "$@"; }
key_field() { # key_field <ro|rw> <ID|SECRET>
  local name=AWS_ACCESS_KEY_ID
  [ "$2" = SECRET ] && name=AWS_SECRET_ACCESS_KEY
  sudo sed -n "s/^$name=//p" "$secrets/sccache/key-$1"
}

echo "--- garage"
for _ in $(seq 1 30); do garage status >/dev/null 2>&1 && break; sleep 1; done
garage status >/dev/null

echo "--- layout"
if garage status | grep -q "NO ROLE ASSIGNED"; then
  node=$(garage node id -q | cut -d@ -f1)
  version=$(garage layout show | sed -n 's/.*[Cc]urrent cluster layout version: *\([0-9][0-9]*\).*/\1/p')
  garage layout assign -z pengutron -c 200G "$node"
  garage layout apply --version $(( ${version:-0} + 1 ))
else
  echo "already assigned"
fi

echo "--- bucket"
garage bucket info sccache >/dev/null 2>&1 || garage bucket create sccache
garage bucket set-quotas --max-size 150GiB sccache >/dev/null

for k in ro rw; do
  echo "--- key sccache-$k"
  id=$(key_field "$k" ID) secret=$(key_field "$k" SECRET)
  [ -n "$id" ] && [ -n "$secret" ] || { echo "no key in $secrets/sccache/key-$k; deployed?" >&2; exit 1; }
  if garage key info "sccache-$k" >/dev/null 2>&1; then
    # A key regenerated in sops after Garage imported the old one would
    # leave every job without the cache; say so rather than carry on.
    garage key info "sccache-$k" | grep -q "$id" \
      || { echo "Garage's sccache-$k is not the one in sops ($id); delete it (garage key delete) and rerun" >&2; exit 1; }
    echo "already imported"
  else
    garage key import --yes -n "sccache-$k" "$id" "$secret" >/dev/null   # its output shows the secret
    echo "imported $id"
  fi
done
garage bucket allow --read --write sccache --key sccache-rw >/dev/null
garage bucket allow --read sccache --key sccache-ro >/dev/null

echo "--- expiry"
# Setting a lifecycle rule needs the bucket's owner; lend that to the
# read-write key for the one call.
garage bucket allow --owner sccache --key sccache-rw >/dev/null
trap 'garage bucket deny --owner sccache --key sccache-rw >/dev/null' EXIT
AWS_ACCESS_KEY_ID=$(key_field rw ID) AWS_SECRET_ACCESS_KEY=$(key_field rw SECRET) \
  nix run nixpkgs#awscli2 -- --endpoint-url "$endpoint" --region garage \
  s3api put-bucket-lifecycle-configuration --bucket sccache --lifecycle-configuration \
  '{"Rules":[{"ID":"expire","Status":"Enabled","Filter":{"Prefix":""},"Expiration":{"Days":30}}]}'
garage bucket deny --owner sccache --key sccache-rw >/dev/null
trap - EXIT

echo "--- done"
garage bucket info sccache
