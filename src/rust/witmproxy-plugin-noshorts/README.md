# witmproxy-plugin-noshorts

Blocks YouTube and Instagram shorts

## Building

To build this plugin:

```bash
make
```

## Installation

After building, the plugin can be installed in witmproxy by running `witm plugin add <path-to-wasm-file>`.

## Template Variables

This plugin was generated from the witmproxy Rust plugin template with the following variables:

- **Plugin Name**: witmproxy-plugin-noshorts
- **Authors**: Theodore Brockman
- **Description**: Blocks YouTube and Instagram shorts

## Customization

- Modify the `manifest()` function in `src/lib.rs` to update plugin metadata
- Implement your plugin logic in the `handle_request()` and `handle_response()` functions
- Update the CEL expression in the manifest to control when your plugin runs
- Add any additional dependencies to `Cargo.toml`