#!/usr/bin/env bash
# Release signing secrets: kept in secrets/release.yaml (sops, the operator's
# key alone; see .sops.yaml) and copied from there to the GitHub secrets that
# release workflows read. sops is the source of truth; GitHub holds copies.
#
#   ./signing-secrets.sh apple P12 P8 KEY_ID ISSUER   store Apple's credentials
#   ./signing-secrets.sh minisign [PUB]                generate the minisign key, once
#   ./signing-secrets.sh push [REPO...]                copy them to GitHub (default ezcorg/dij)
#
# apple: P12 is the Developer ID Application certificate with its key,
# exported from Keychain Access (its password is asked for); P8 an App Store
# Connect API key, with its KEY_ID and ISSUER. The signing identity comes from
# the certificate. minisign: a key without a password, so CI signs unattended;
# prints the public key and writes it to PUB if given (dij keeps it as
# minisign.pub). Run where sops can decrypt (on macOS, export
# SOPS_AGE_KEY_FILE first; see README.md). Needs sops, jq and openssl; push
# needs gh.
set -euo pipefail
start=$PWD   # paths on the command line are relative to here
cd "$(dirname "$0")"
file=secrets/release.yaml

die() { echo "$*" >&2; exit 1; }
abs() { case $1 in /*) printf '%s' "$1" ;; *) printf '%s' "$start/$1" ;; esac; }
usage() { sed -n '6,8s/^# *//p' "$0" >&2; exit 2; }
# Not grep -q: under pipefail its early exit fails the pipeline.
sops set --help 2>&1 | grep -- --value-stdin >/dev/null || die "this sops is too old: its set has no --value-stdin"

# put PATH: store stdin, a raw string, at PATH, creating the file if need be.
put() {
  if [ ! -f "$file" ]; then
    printf '{}\n' | sops encrypt --filename-override "$file" --input-type yaml --output-type yaml /dev/stdin > "$file.new"
    mv "$file.new" "$file"
  fi
  jq -Rs . | sops set --value-stdin "$file" "$1"
}
get() { sops -d --extract "$1" "$file" 2>/dev/null; }
# type -P, not command -v, which would find this function itself.
minisign() { if type -P minisign >/dev/null; then command minisign "$@"; else nix run nixpkgs#minisign -- "$@"; fi; }

apple() {
  [ $# -eq 4 ] || usage
  local p12 p8 key_id=$3 issuer=$4 password identity="" legacy
  p12=$(abs "$1") p8=$(abs "$2")
  [ -f "$p12" ] || die "no such file: $p12"
  [ -f "$p8" ] || die "no such file: $p8"
  read -r -s -p "Password for $p12: " password; echo >&2
  # Keychain Access exports with algorithms OpenSSL 3 calls legacy;
  # LibreSSL, macOS's openssl, reads them as they are.
  for legacy in "" -legacy; do
    identity=$(P12_PASSWORD=$password openssl pkcs12 -in "$p12" -nokeys -clcerts -passin env:P12_PASSWORD ${legacy:+"$legacy"} 2>/dev/null \
      | openssl x509 -noout -subject -nameopt multiline 2>/dev/null \
      | sed -n 's/^ *commonName *= *//p') && [ -n "$identity" ] && break
  done
  [ -n "$identity" ] || die "could not read $p12 (wrong password?)"
  case "$identity" in
    "Developer ID Application:"*) ;;
    *) die "$p12 holds \"$identity\", not a Developer ID Application certificate" ;;
  esac
  printf '%s' "$identity" | put '["apple"]["signing-identity"]'
  base64 < "$p12" | tr -d '\n' | put '["apple"]["certificate-p12"]'
  printf '%s' "$password" | put '["apple"]["certificate-password"]'
  put '["apple"]["notary-key"]' < "$p8"
  printf '%s' "$key_id" | put '["apple"]["notary-key-id"]'
  printf '%s' "$issuer" | put '["apple"]["notary-issuer"]'
  echo "stored $identity, and notary key $key_id"
}

minisign_key() {
  [ $# -le 1 ] || usage
  if ! get '["minisign"]["key"]' >/dev/null; then
    tmp=$(mktemp -d)   # global: the EXIT trap outlives this function
    trap 'rm -rf "$tmp"' EXIT
    minisign -G -W -p "$tmp/pub" -s "$tmp/key" >/dev/null
    put '["minisign"]["key"]' < "$tmp/key"
    put '["minisign"]["pub"]' < "$tmp/pub"
    echo "generated a minisign key; its public half:" >&2
  fi
  get '["minisign"]["pub"]'
  if [ -n "${1:-}" ]; then get '["minisign"]["pub"]' > "$(abs "$1")"; echo "wrote $1" >&2; fi
}

push() {
  [ $# -gt 0 ] || set -- ezcorg/dij
  local repo path name value
  for repo in "$@"; do
    while read -r path name; do
      if value=$(get "$path"); then
        printf '%s' "$value" | gh secret set "$name" -R "$repo"
        echo "$repo: $name"
      else
        echo "$repo: $name skipped, not in $file"
      fi
    done <<'MAP'
["apple"]["signing-identity"] MACOS_SIGNING_IDENTITY
["apple"]["certificate-p12"] MACOS_CERTIFICATE_P12
["apple"]["certificate-password"] MACOS_CERTIFICATE_PASSWORD
["apple"]["notary-key"] NOTARY_KEY
["apple"]["notary-key-id"] NOTARY_KEY_ID
["apple"]["notary-issuer"] NOTARY_ISSUER
["minisign"]["key"] MINISIGN_KEY
MAP
  done
}

case "${1:-}" in
  apple) shift; apple "$@" ;;
  minisign) shift; minisign_key "$@" ;;
  push) shift; push "$@" ;;
  *) usage ;;
esac
