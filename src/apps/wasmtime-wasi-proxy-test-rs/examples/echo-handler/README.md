# Echo Handler Example

This is an example WASM component that implements the WASI HTTP proxy interface. It demonstrates how to create a handler that can be loaded by the `wasmtime-wasi-proxy-test-rs` server.

## What it does

The echo handler:
- Receives HTTP requests
- Extracts request details (method, URI, headers, body)
- Returns a JSON response containing all the request information
- Demonstrates basic request/response handling in a WASM component

## Building

To build this component, you need:
- Rust toolchain with `wasm32-wasip2` target
- `cargo-component` tool

### Install prerequisites

```bash
# Install the wasm32-wasip2 target
rustup target add wasm32-wasip2

# Install cargo-component
cargo install cargo-component
```

### Build the component

```bash
cd src/apps/wasmtime-wasi-proxy-test-rs/examples/echo-handler
cargo component build --release
```

This will create a WASM component at:
`target/wasm32-wasip2/release/echo_handler.wasm`

## Usage

1. Build the echo handler component (see above)
2. Build and run the main proxy server:

```bash
cd src/apps/wasmtime-wasi-proxy-test-rs
cargo run -- examples/echo-handler/target/wasm32-wasip2/release/echo_handler.wasm
```

3. Test the handler:

```bash
# Simple GET request
curl http://127.0.0.1:8000/test

# POST request with data
curl -X POST http://127.0.0.1:8000/api/test \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello World"}'

# Request with custom headers
curl http://127.0.0.1:8000/custom \
  -H "X-Custom-Header: test-value" \
  -H "Authorization: Bearer token123"
```

## Example Response

```json
{
  "echo": {
    "method": "POST",
    "uri": "/api/test",
    "headers": {
      "content-type": "application/json",
      "content-length": "25"
    },
    "body": "{\"message\": \"Hello World\"}"
  },
  "message": "Hello from Echo Handler WASM Component!"
}
```

## Creating Your Own Handler

Use this as a template to create your own WASM handlers:

1. Copy the directory structure
2. Modify the `src/lib.rs` to implement your custom logic
3. Update the `Cargo.toml` with your component name
4. Build and test with the proxy server

The key points for implementing a handler:
- Implement the `Guest` trait from `bindings::exports::wasi::http::incoming_handler`
- Handle the `handle` function with `IncomingRequest` and `ResponseOutparam`
- Use the WASI HTTP types for request/response manipulation
- Export your component with `bindings::export!(Component with_types_in bindings)`