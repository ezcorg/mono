#!/bin/bash

set -euo pipefail

# Script to build and publish witmproxy WIT package to ghcr.io
# Usage: ./publish-wit.sh [VERSION] [REGISTRY_OWNER]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WITMPROXY_DIR="$REPO_ROOT/src/apps/witmproxy"

# Configuration
REGISTRY="ghcr.io"
PACKAGE_NAMESPACE="witmproxy"
PACKAGE_NAME="plugin"
DEFAULT_VERSION="0.0.1"

# Function to print usage
usage() {
    echo "Usage: $0 [VERSION] [REGISTRY_OWNER]"
    echo ""
    echo "Arguments:"
    echo "  VERSION        Version to publish (default: extract from Cargo.toml or $DEFAULT_VERSION)"
    echo "  REGISTRY_OWNER Registry owner/organization (required for publishing)"
    echo ""
    echo "Environment variables:"
    echo "  GITHUB_TOKEN   Required for authentication to ghcr.io"
    echo ""
    echo "Examples:"
    echo "  $0 0.1.0 myorg"
    echo "  $0"
    echo ""
    exit 1
}

# Parse arguments and handle help
if [[ "$1" == "--help" || "$1" == "-h" ]]; then
    usage
fi

VERSION="${1:-}"
REGISTRY_OWNER="${2:-}"

# Function to extract version from Cargo.toml
get_version_from_cargo() {
    local cargo_toml="$WITMPROXY_DIR/Cargo.toml"
    if [[ -f "$cargo_toml" ]]; then
        grep '^version = ' "$cargo_toml" | sed 's/version = "\(.*\)"/\1/' | head -n1
    else
        echo "$DEFAULT_VERSION"
    fi
}

# Function to check if wkg is installed
check_wkg() {
    if ! command -v wkg &> /dev/null; then
        echo "Error: wkg (wasm-pkg-tools) is not installed"
        echo "Install it with: cargo install wasm-pkg-tools"
        return 1
    fi
    echo "Found wkg: $(wkg --version)"
}

# Function to setup wkg configuration
setup_wkg_config() {
    local owner="$1"
    local config_dir="$HOME/.config/wasm-pkg"
    local config_file="$config_dir/config.toml"
    
    echo "Setting up wkg configuration..."
    mkdir -p "$config_dir"
    
    cat > "$config_file" << EOF
default_registry = "$REGISTRY"

[namespace_registries]
wasi = { registry = "wasi",  metadata = { preferredProtocol = "oci", "oci" = {registry = "ghcr.io", namespacePrefix = "webassembly/" } } }
$PACKAGE_NAMESPACE = { registry = "$PACKAGE_NAMESPACE", metadata = { preferredProtocol = "oci", "oci" = { registry = "$REGISTRY", namespacePrefix = "$owner/" } } }
EOF
    
    echo "wkg configuration created at $config_file:"
    cat "$config_file"
}

# Function to build WIT as WebAssembly component
build_wit() {
    echo "Building WIT as WebAssembly component..."
    cd "$WITMPROXY_DIR"
    
    # Clean any existing .wasm files
    rm -f *.wasm
    
    # Build WIT directory as a Wasm component
    wkg wit build --wit-dir wit
    
    # Verify the output
    local wasm_files=(*.wasm)
    if [[ ${#wasm_files[@]} -eq 0 || ! -f "${wasm_files[0]}" ]]; then
        echo "Error: No .wasm files found after building"
        return 1
    fi
    
    echo "Successfully built: ${wasm_files[*]}"
}

# Function to publish WIT package
publish_wit() {
    local version="$1"
    local package_full="$PACKAGE_NAMESPACE:$PACKAGE_NAME@$version"
    
    echo "Publishing WIT"
    cd "$WITMPROXY_DIR"
    
    # Find the generated .wasm file
    local wasm_files=(*.wasm)
    if [[ ${#wasm_files[@]} -eq 0 || ! -f "${wasm_files[0]}" ]]; then
        echo "Error: No .wasm file found for publishing"
        return 1
    fi
    
    local wasm_file="${wasm_files[0]}"
    echo "Publishing $wasm_file"
    
    # Publish using wkg
    wkg publish "$wasm_file"
    
    echo "WIT package published successfully!"
}

# Function to display publication info
show_publication_info() {
    local version="$1"
    local owner="$2"
    
    echo ""
    echo "================================================"
    echo "WIT Package Publication Summary"
    echo "================================================"
    echo "Package: $PACKAGE_NAMESPACE:$PACKAGE_NAME@$version"
    echo "Registry: $REGISTRY/$owner/$PACKAGE_NAMESPACE/$PACKAGE_NAME:$version"
    echo ""
    echo "To fetch this WIT package, configure wkg and run:"
    echo "wkg get --format wit $PACKAGE_NAMESPACE:$PACKAGE_NAME@$version --output plugin.wit"
    echo ""
    echo "Or use the OCI reference directly:"
    echo "wkg oci pull $REGISTRY/$owner/${PACKAGE_NAMESPACE}/${PACKAGE_NAME}:$version -o plugin.wasm"
    echo "================================================"
}

# Main execution
main() {
    echo "Starting witmproxy WIT publication process..."
    
    # Determine version
    if [[ -z "$VERSION" ]]; then
        VERSION=$(get_version_from_cargo)
        echo "Using version from Cargo.toml: $VERSION"
    else
        echo "Using provided version: $VERSION"
    fi
    
    # Validate registry owner for publishing
    if [[ -z "$REGISTRY_OWNER" ]]; then
        echo "Warning: REGISTRY_OWNER not provided"
        echo "This is required for publishing to ghcr.io"
        if [[ -n "${GITHUB_REPOSITORY_OWNER:-}" ]]; then
            REGISTRY_OWNER="$GITHUB_REPOSITORY_OWNER"
            echo "Using GITHUB_REPOSITORY_OWNER: $REGISTRY_OWNER"
        else
            echo "Error: REGISTRY_OWNER is required for publishing"
            usage
        fi
    fi
    
    # Check prerequisites
    check_wkg
    
    # Setup configuration
    setup_wkg_config "$REGISTRY_OWNER"

    # Login to ghcr.io using GITHUB_TOKEN
    if [[ -z "${GITHUB_TOKEN:-}" ]]; then
        echo "Error: GITHUB_TOKEN environment variable is not set"
        echo "This token is required for authentication to ghcr.io"
        echo "Generate a token with 'write:packages' and 'read:packages' scopes"
        echo "and set it as an environment variable before running this script"
        exit 1
    fi

    echo "Logging in to ghcr.io with GITHUB_TOKEN..."
    echo "$GITHUB_TOKEN" | docker login ghcr.io -u "$REGISTRY_OWNER" --password-stdin
    
    # Build WIT
    build_wit
    
    # Publish WIT
    publish_wit "$VERSION"
    
    # Show publication info
    show_publication_info "$VERSION" "$REGISTRY_OWNER"
}

# Run main function if script is executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi