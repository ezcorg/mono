#!/bin/bash

set -e

echo "🔨 Building MITM Proxy RS"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if Rust is installed
if ! command -v cargo &> /dev/null; then
    print_error "Rust/Cargo not found. Please install Rust from https://rustup.rs/"
    exit 1
fi

# Check if wasm32 target is installed
if ! rustup target list --installed | grep -q "wasm32-unknown-unknown"; then
    print_warning "wasm32-unknown-unknown target not found. Installing..."
    rustup target add wasm32-unknown-unknown
    print_success "wasm32-unknown-unknown target installed"
fi

# Create necessary directories
print_status "Creating directories..."
mkdir -p plugins
mkdir -p certs
mkdir -p web-ui/static
mkdir -p web-ui/templates

# Build the main proxy
print_status "Building main proxy..."
cargo build --release
print_success "Main proxy built successfully"

# Build plugins
print_status "Building plugins..."

# Build logger plugin
if [ -d "plugins/examples/logger" ]; then
    print_status "Building logger plugin..."
    cd plugins/examples/logger
    cargo build --target wasm32-unknown-unknown --release
    cp target/wasm32-unknown-unknown/release/logger_plugin.wasm ../../../plugins/logger.wasm
    cd ../../..
    print_success "Logger plugin built"
else
    print_warning "Logger plugin directory not found, skipping..."
fi

# Build other example plugins if they exist
for plugin_dir in plugins/examples/*/; do
    if [ -d "$plugin_dir" ] && [ "$(basename "$plugin_dir")" != "logger" ]; then
        plugin_name=$(basename "$plugin_dir")
        print_status "Building $plugin_name plugin..."
        cd "$plugin_dir"
        if cargo build --target wasm32-unknown-unknown --release 2>/dev/null; then
            # Find the .wasm file (handle different naming conventions)
            wasm_file=$(find target/wasm32-unknown-unknown/release/ -name "*.wasm" | head -1)
            if [ -n "$wasm_file" ]; then
                cp "$wasm_file" "../../../plugins/${plugin_name}.wasm"
                print_success "$plugin_name plugin built"
            else
                print_warning "No .wasm file found for $plugin_name"
            fi
        else
            print_warning "Failed to build $plugin_name plugin"
        fi
        cd ../../..
    fi
done

# Create default configuration if it doesn't exist
if [ ! -f "config.toml" ]; then
    print_status "Creating default configuration..."
    cat > config.toml << EOF
[proxy]
max_connections = 1000
connection_timeout_secs = 30
buffer_size = 8192
upstream_timeout_secs = 30

[tls]
cert_validity_days = 365
key_size = 2048
cache_size = 1000

[plugins]
enabled = true
timeout_ms = 5000
max_memory_mb = 64

[web]
enable_dashboard = true
static_dir = "./web-ui/static"
template_dir = "./web-ui/templates"
EOF
    print_success "Default configuration created"
fi

# Create a simple start script
print_status "Creating start script..."
cat > start.sh << 'EOF'
#!/bin/bash

echo "🚀 Starting MITM Proxy RS"

# Default values
PROXY_ADDR="127.0.0.1:8080"
WEB_ADDR="127.0.0.1:8081"
CONFIG="config.toml"
VERBOSE=""

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -p|--proxy-addr)
            PROXY_ADDR="$2"
            shift 2
            ;;
        -w|--web-addr)
            WEB_ADDR="$2"
            shift 2
            ;;
        -c|--config)
            CONFIG="$2"
            shift 2
            ;;
        -v|--verbose)
            VERBOSE="--verbose"
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo "Options:"
            echo "  -p, --proxy-addr ADDR    Proxy listen address (default: 127.0.0.1:8080)"
            echo "  -w, --web-addr ADDR      Web interface address (default: 127.0.0.1:8081)"
            echo "  -c, --config FILE        Configuration file (default: config.toml)"
            echo "  -v, --verbose            Enable verbose logging"
            echo "  -h, --help               Show this help message"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

echo "Proxy will listen on: $PROXY_ADDR"
echo "Web interface will be available at: http://$WEB_ADDR"
echo "Configuration file: $CONFIG"
echo ""
echo "To install the certificate:"
echo "1. Configure your browser to use $PROXY_ADDR as HTTP/HTTPS proxy"
echo "2. Visit http://$WEB_ADDR in your browser"
echo "3. Download and install the certificate for your platform"
echo ""
echo "Press Ctrl+C to stop the proxy"
echo ""

exec ./target/release/mitm-proxy \
    --proxy-addr "$PROXY_ADDR" \
    --web-addr "$WEB_ADDR" \
    --config "$CONFIG" \
    $VERBOSE
EOF

chmod +x start.sh
print_success "Start script created"

# Print final instructions
echo ""
print_success "🎉 Build completed successfully!"
echo ""
echo "📋 Next steps:"
echo "   1. Run './start.sh' to start the proxy"
echo "   2. Configure your browser to use 127.0.0.1:8080 as HTTP/HTTPS proxy"
echo "   3. Visit http://127.0.0.1:8081 to download the certificate"
echo ""
echo "📁 Files created:"
echo "   • target/release/mitm-proxy - Main executable"
echo "   • plugins/*.wasm - WASM plugins"
echo "   • config.toml - Configuration file"
echo "   • start.sh - Convenience start script"
echo ""
echo "🔧 Advanced usage:"
echo "   • Edit config.toml to customize settings"
echo "   • Add custom plugins to the plugins/ directory"
echo "   • Use './start.sh --help' for more options"
echo ""