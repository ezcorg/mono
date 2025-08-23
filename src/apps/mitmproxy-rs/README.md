# MITM Proxy RS

A high-performance man-in-the-middle proxy written in Rust with WebAssembly plugin support.

## Features

- 🔒 **TLS Interception**: Automatic certificate generation and TLS termination
- 🧩 **WASM Plugin System**: Extensible plugin architecture using WebAssembly
- 📱 **Smart Certificate Distribution**: Automatic device detection and certificate format selection
- 🌐 **Web Interface**: Built-in web server for certificate downloads and management
- ⚡ **High Performance**: Built with Rust and Tokio for maximum performance
- 🔧 **Easy Configuration**: TOML-based configuration with sensible defaults

## Quick Start

### Prerequisites

- Rust 1.70+ with `wasm32-unknown-unknown` target
- `wasm-pack` for building WASM plugins

```bash
# Install Rust target for WASM
rustup target add wasm32-unknown-unknown

# Install wasm-pack
curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
```

### Building

```bash
# Clone the repository
git clone <repository-url>
cd mitm-proxy-rs

# Build the main proxy
cargo build --release

# Build example plugins
cd plugins/examples/logger
cargo build --target wasm32-unknown-unknown --release
cp target/wasm32-unknown-unknown/release/logger_plugin.wasm ../../../plugins/
cd ../../..
```

### Running

```bash
# Start the proxy with default settings
./target/release/mitm-proxy

# Or with custom configuration
./target/release/mitm-proxy --config config.toml --proxy-addr 127.0.0.1:8080 --web-addr 127.0.0.1:8081
```

### Certificate Installation

1. Configure your browser/device to use `127.0.0.1:8080` as HTTP/HTTPS proxy
2. Visit `http://127.0.0.1:8081` in your browser
3. Download and install the certificate for your platform
4. Start intercepting HTTPS traffic!

## Configuration

Create a `config.toml` file:

```toml
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
```

## Plugin Development

### Creating a Plugin

1. Create a new Rust library project:

```bash
cargo new --lib my-plugin
cd my-plugin
```

2. Add the SDK dependency to `Cargo.toml`:

```toml
[lib]
crate-type = ["cdylib"]

[dependencies]
mitm_plugin_sdk = { path = "../path/to/sdk" }
paste = "1.0"
```

3. Implement your plugin in `src/lib.rs`:

```rust
use mitm_plugin_sdk::*;

// Define plugin metadata
plugin_metadata!(
    "my-plugin",
    "1.0.0", 
    "My awesome plugin",
    "Your Name",
    &["request_headers", "response_headers"]
);

// Handle request headers
plugin_event_handler!("request_headers", handle_request_headers);

fn handle_request_headers(context: RequestContext) -> PluginResult {
    log_info!("Processing request to {}", context.request.url);
    
    // Add custom header
    PluginApi::modify_request_header("X-Custom-Header", "Hello from plugin!");
    
    PluginResult::Continue
}

// Handle response headers  
plugin_event_handler!("response_headers", handle_response_headers);

fn handle_response_headers(context: RequestContext) -> PluginResult {
    if let Some(response) = &context.response {
        log_info!("Response status: {}", response.status);
        
        // Add security header
        PluginApi::modify_response_header("X-Plugin-Processed", "true");
    }
    
    PluginResult::Continue
}
```

4. Build the plugin:

```bash
cargo build --target wasm32-unknown-unknown --release
cp target/wasm32-unknown-unknown/release/my_plugin.wasm /path/to/proxy/plugins/
```

### Plugin Events

Plugins can handle the following events:

- `request_start`: When a new request begins
- `request_headers`: When request headers are received
- `request_body`: When request body is received
- `response_start`: When response starts
- `response_headers`: When response headers are received  
- `response_body`: When response body is received
- `connection_open`: When a new connection opens
- `connection_close`: When a connection closes

### Plugin API

The plugin SDK provides these APIs:

- **Logging**: `log_info!()`, `log_warn!()`, `log_error!()`, etc.
- **Storage**: `PluginApi::storage_set()`, `PluginApi::storage_get()`
- **HTTP Modification**: `PluginApi::modify_request_header()`, `PluginApi::modify_response_header()`
- **HTTP Requests**: `PluginApi::http_request()`
- **Utilities**: `PluginApi::get_timestamp()`, `PluginApi::get_context()`

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Client App    │    │   MITM Proxy    │    │  Target Server  │
│                 │    │                 │    │                 │
│  ┌───────────┐  │    │  ┌───────────┐  │    │  ┌───────────┐  │
│  │  Browser  │◄─┼────┼─►│    TLS    │◄─┼────┼─►│   HTTPS   │  │
│  └───────────┘  │    │  │Termination│  │    │  │  Server   │  │
│                 │    │  └───────────┘  │    │  └───────────┘  │
└─────────────────┘    │  ┌───────────┐  │    └─────────────────┘
                       │  │   WASM    │  │
┌─────────────────┐    │  │  Plugins  │  │
│  Web Interface  │    │  └───────────┘  │
│                 │    │  ┌───────────┐  │
│  ┌───────────┐  │    │  │   Cert    │  │
│  │   Cert    │◄─┼────┼─►│    CA     │  │
│  │ Download  │  │    │  └───────────┘  │
│  └───────────┘  │    └─────────────────┘
└─────────────────┘
```

## Security Considerations

⚠️ **Important Security Notes:**

1. **Certificate Trust**: Installing the root certificate allows the proxy to decrypt all HTTPS traffic
2. **Plugin Security**: WASM plugins run in a sandboxed environment but can still access network and storage
3. **Network Security**: Only use on trusted networks
4. **Data Handling**: Be careful with sensitive data in plugin logs and storage

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## Acknowledgments

- [mitmproxy](https://mitmproxy.org/) for inspiration
- [Rust](https://rust-lang.org/) for the amazing language
- [WebAssembly](https://webassembly.org/) for the plugin system
- [Tokio](https://tokio.rs/) for async runtime
- [rustls](https://github.com/rustls/rustls) for TLS implementation