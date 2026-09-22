#!/usr/bin/env bash
# The realistic path for a novel capability in the demo: a second, distinct
# daemon (the "publisher") serves its own OCI registry with the links example
# published; the daemon behind the demo (the "consumer", ws://127.0.0.1:7777
# by default) is given a credential for that registry; the demo page names the
# component by hash and source, the consumer fetches it, checks the hash, and
# shows the consent card with where it came from. Nothing of the publisher's is
# used remotely: the index runs on the consumer, over the consumer's vault.
#
#   src/apps/icanhaz/scripts/demo-publisher.sh            # start the publisher, publish, configure the consumer, print the demo URL
#   CONSUMER_WS=ws://127.0.0.1:7777 ...                    # the daemon behind the demo (default)
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(cd ../../.. && pwd)"
CONSUMER_WS=${CONSUMER_WS:-ws://127.0.0.1:7777}
PUB_WS=${PUB_WS:-127.0.0.1:7787}
PUB_WT=${PUB_WT:-127.0.0.1:7788}
PUB_REGISTRY=${PUB_REGISTRY:-127.0.0.1:7790}
USER_NAME=${REGISTRY_USER:-publisher}
PASSWORD=${REGISTRY_PASSWORD:-$(head -c 12 /dev/urandom | base64 | tr -d '/+=')}
STATE=$(mktemp -d "${TMPDIR:-/tmp}/icanhaz-publisher.XXXXXX")

[ -f host/fixtures/links.wasm ] || { echo "build the wasm guests first: scripts/build-wasm.sh" >&2; exit 1; }
(cd "$REPO" && cargo build -q --bin icanhazd --bin icanhaz)
BIN="$(cd "$REPO" && cargo metadata --format-version 1 --no-deps | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')/debug"

echo "== publisher: ws://$PUB_WS, registry http://$PUB_REGISTRY, state $STATE"
ICANHAZ_WS_BIND="$PUB_WS" ICANHAZ_WT_BIND="$PUB_WT" ICANHAZ_REGISTRY_BIND="$PUB_REGISTRY" \
ICANHAZ_ROOT="$STATE/root" ICANHAZ_DB="$STATE/icanhaz.db" ICANHAZ_DB_KEY=demo \
ICANHAZ_PAIRINGS="$STATE/pairings.json" ICANHAZ_HOSTS="$STATE/hosts.json" \
ICANHAZ_CONSENT=auto ICANHAZ_IROH=0 "$BIN/icanhazd" >"$STATE/publisher.log" 2>&1 &
PUB_PID=$!
trap 'kill $PUB_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do nc -z "${PUB_WS%:*}" "${PUB_WS#*:}" 2>/dev/null && break; sleep 0.25; done

# The registry serves nothing until its credential is set; then publish.
"$BIN/icanhaz" capability configure registry default "username=$USER_NAME" "password:secret=$PASSWORD" --daemon "ws://$PUB_WS" >/dev/null
HASH=$("$BIN/icanhaz" capability add host/fixtures/links.wasm --daemon "ws://$PUB_WS" --source "https://github.com/tbrockman/mono/tree/main/src/apps/icanhaz/examples/links")
"$BIN/icanhaz" capability publish "$HASH" example/links:v1 --daemon "ws://$PUB_WS" >/dev/null
SOURCE="oci://$PUB_REGISTRY/example/links:v1"
echo "== published $HASH as $SOURCE"

# The consumer signs in to the publisher's registry with that credential.
"$BIN/icanhaz" capability configure registries "$PUB_REGISTRY" "username=$USER_NAME" "password:secret=$PASSWORD" --daemon "$CONSUMER_WS" >/dev/null
echo "== consumer at $CONSUMER_WS has a credential for $PUB_REGISTRY"

URL="http://localhost:5173/?links-provider=$HASH&links-source=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$SOURCE")"
echo
echo "open the demo with the component named by hash and source:"
echo "  $URL"
echo
echo "the publisher runs until this script is stopped (ctrl-c); its log is $STATE/publisher.log"
wait $PUB_PID
