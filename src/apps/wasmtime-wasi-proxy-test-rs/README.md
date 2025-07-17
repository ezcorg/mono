# Wasmtime WASI Proxy Test

A Rust HTTP server that loads and executes WASM components implementing the WASI HTTP proxy interface. This server demonstrates how to create a proxy that can dynamically load multiple WASM handlers and route requests through them.

## Features

- Load multiple WASM components as HTTP handlers
- Route requests through all loaded handlers sequentially
- Support for WASI HTTP proxy interface
- Async request handling with Tokio
- Example handlers included

## Building and Running

### Prerequisites

- Rust toolchain
- `cargo-component` for building WASM components

```bash
# Install cargo-component
cargo install cargo-component

# Install wasm32-wasip2 target
rustup target add wasm32-wasip2
```

### Build the Server

```bash
cd src/apps/wasmtime-wasi-proxy-test-rs
cargo build --release
```

### Build Example Handlers

```bash
# Build echo handler
cd examples/echo-handler
cargo component build --release

# Build JSON API handler
cd ../json-api-handler
cargo component build --release
```

### Run the Server

```bash
# Run with one handler
cargo run -- examples/echo-handler/target/wasm32-wasip2/release/echo_handler.wasm

# Run with multiple handlers
cargo run -- \
  examples/echo-handler/target/wasm32-wasip2/release/echo_handler.wasm \
  examples/json-api-handler/target/wasm32-wasip2/release/json_api_handler.wasm
```

The server will start on `http://127.0.0.1:8000`

## Example Handlers

### Echo Handler

A simple handler that echoes back request information in JSON format.

**Test it:**
```bash
curl http://127.0.0.1:8000/test
curl -X POST http://127.0.0.1:8000/api -d '{"test": "data"}'
```

### JSON API Handler

A more complex handler that implements a REST API with multiple endpoints.

**Test it:**
```bash
# API info
curl http://127.0.0.1:8000/

# Health check
curl http://127.0.0.1:8000/api/health

# List users
curl http://127.0.0.1:8000/api/users

# Get specific user
curl http://127.0.0.1:8000/api/users/1

# Create user
curl -X POST http://127.0.0.1:8000/api/users \
  -H "Content-Type: application/json" \
  -d '{"name": "John", "email": "john@example.com"}'
```

## How It Works

1. **Component Loading**: The server loads WASM components from file paths provided as command line arguments
2. **Request Processing**: Each incoming HTTP request is processed by all loaded handlers sequentially
3. **Response Handling**: The response from the last successful handler is returned to the client
4. **WASI Integration**: Uses `wasmtime-wasi-http` for WASI HTTP interface implementation

## Creating Custom Handlers

To create your own WASM handler:

1. Use the example handlers as templates
2. Implement the `wasi:http/incoming-handler` interface
3. Build with `cargo component build`
4. Load with the proxy server

### Handler Interface

Your handler must implement:

```rust
impl Guest for Component {
    fn handle(request: IncomingRequest, response_out: ResponseOutparam) {
        // Your handler logic here
    }
}
```

## Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   HTTP Client   │───▶│  Proxy Server    │───▶│ WASM Handler 1  │
└─────────────────┘    │                  │    └─────────────────┘
                       │  - Load WASM     │    ┌─────────────────┐
                       │  - Route Requests│───▶│ WASM Handler 2  │
                       │  - Manage State  │    └─────────────────┘
                       └──────────────────┘    ┌─────────────────┐
                                              │ WASM Handler N  │
                                              └─────────────────┘
```

## Dependencies

- `wasmtime`: WASM runtime
- `wasmtime-wasi`: WASI implementation
- `wasmtime-wasi-http`: WASI HTTP bindings
- `hyper`: HTTP server
- `tokio`: Async runtime

## License

This project follows the same license as the parent repository.