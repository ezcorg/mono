#!/bin/bash

# End-to-End Test Runner for MITM Proxy
# This script sets up the environment and runs comprehensive tests

set -e

echo "🚀 MITM Proxy End-to-End Test Runner"
echo "===================================="

# Check prerequisites
echo "📋 Checking prerequisites..."

# Check if Rust is installed
if ! command -v cargo &> /dev/null; then
    echo "❌ Cargo not found. Please install Rust: https://rustup.rs/"
    exit 1
fi

# Check if wasm32-unknown-unknown target is installed
if ! rustup target list --installed | grep -q "wasm32-unknown-unknown"; then
    echo "📦 Installing wasm32-unknown-unknown target..."
    rustup target add wasm32-unknown-unknown
else
    echo "✅ wasm32-unknown-unknown target is installed"
fi

# Check if required ports are available
check_port() {
    local port=$1
    local service=$2
    if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1; then
        echo "❌ Port $port is already in use (needed for $service)"
        echo "   Please stop the service using this port and try again"
        exit 1
    else
        echo "✅ Port $port is available for $service"
    fi
}

echo "🔍 Checking port availability..."
check_port 18080 "proxy"
check_port 18081 "web interface"
check_port 18082 "sample service"

# Set environment variables for testing
export RUST_LOG=info
export RUST_BACKTRACE=1

echo ""
echo "🧪 Running End-to-End Tests"
echo "=========================="

# Run the tests with verbose output
echo "Running plugin loading test..."
cargo test --test e2e_test test_plugin_loading -- --nocapture

echo ""
echo "Running full end-to-end test..."
cargo test --test e2e_test test_e2e_mitm_proxy_with_plugins -- --nocapture

echo ""
echo "🎉 All tests completed successfully!"
echo ""
echo "📊 Test Summary:"
echo "  ✅ Plugin compilation and loading"
echo "  ✅ Sample service functionality"
echo "  ✅ Proxy server startup and configuration"
echo "  ✅ Logger plugin functionality"
echo "  ✅ JSON validator plugin functionality"
echo "  ✅ HTML analyzer plugin functionality"
echo "  ✅ Plugin integration and data flow"
echo "  ✅ Cleanup and resource management"
echo ""
echo "🔧 The test verified:"
echo "  • All example plugins compile to WASM successfully"
echo "  • Plugin manager loads and manages plugins correctly"
echo "  • Proxy intercepts and processes HTTP requests"
echo "  • Logger plugin tracks requests, timing, and metadata"
echo "  • JSON validator detects sensitive data and validates responses"
echo "  • HTML analyzer identifies security issues and extracts metadata"
echo "  • All plugins work together without conflicts"
echo "  • Services start up and shut down cleanly"
echo ""
echo "✨ Your MITM proxy with WASM plugins is working perfectly!"