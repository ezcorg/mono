# MITM Proxy RS

A high-performance man-in-the-middle proxy written in Rust with WebAssembly plugin support.

## Features

- 🔒 **TLS Interception**: Automatic certificate generation and TLS termination
- 🧩 **WASM Plugin System**: Extensible plugin architecture using WebAssembly
- 📱 **Smart Certificate Distribution**: Automatic device detection and certificate format selection
- 🌐 **Web Interface**: Built-in web server for certificate downloads and management
- 🔧 **Easy Configuration**: TOML-based configuration with sensible defaults

## Quick Start

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