#!/usr/bin/env bash
# Extracts the OpenAPI spec from a running witmproxy server (or starts a temp one)
# and stores it in the well-known api/generated/ directory.
#
# Usage:
#   ./scripts/extract-openapi.sh                    # auto-detect from services.json
#   ./scripts/extract-openapi.sh --server https://...  # from a specific server

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="$PROJECT_DIR/api/generated"
OUTPUT_FILE="$OUTPUT_DIR/openapi.json"

mkdir -p "$OUTPUT_DIR"

echo "Fetching OpenAPI spec..."
cargo run -p witmproxy --bin witm -- openapi "$@" --output "$OUTPUT_FILE"

echo ""
echo "OpenAPI spec saved to: $OUTPUT_FILE"
echo "This is a generated file - do not edit manually."
