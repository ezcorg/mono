# witmproxy <sup>⚠️ `under construction` 👷</sup>

A WASM-in-the-middle proxy, written in Rust.

## Features

- 🧩 **WASM Plugin System**: Extensible plugin architecture built on [WebAssembly Components](https://component-model.bytecodealliance.org/)
- 🔒 **TLS Interception**: Automatic certificate generation and TLS termination
- 📱 **Smart Certificate Distribution**: Automatic device detection and certificate format selection
- 🌐 **Web Interface**: Built-in web server for certificate downloads and management
- 🔧 **Easy Configuration**: TOML-based configuration with sensible defaults

## Quick Start

### 1. Installation and setup

```sh
cargo install witmproxy
witmproxy start # starts in the background, restarts on startup
witmproxy stop # stop the service, until explictly restarted
```

### 2. Add plugins

Plugins are how you can extend `witmproxy` with whatever functionality your heart desires.

```sh
witmproxy add @ezdev/hello # add a plugin from the witmproxy.rs registry
witmproxy add ./path/to/component.wasm # add a local plugin
```

### 3. Creating a new plugin

```sh
witmproxy new plugin <name> [...options] # creates plugin scaffolding
```

### 4. `todo:` Creating capabilities

```sh
witmproxy new capability <interface> # creates capability scaffolding
```

###

## Architecture

A not entirely correct but pretty LLM-generated diagram:

```
┌─────────────────┐      ┌─────────────────────────────┐      ┌─────────────────┐
│   User device   │      │          witmproxy          │      │  Target Server  │
│                 │      │                             │      │                 │
│  ┌───────────┐  │      │  ┌───────────────────────┐  │      │  ┌───────────┐  │
│  │    App /  │◄─┼──────┼─►│    TLS Termination    │◄─┼──────┼─►│   HTTPS   │  │
|  |  Browser  |  |      │  └───────────────────────┘  │      │  │  Server   │  │
│  └───────────┘  │      │  ┌───────────────────────┐  │      │  └───────────┘  │
│                 │      │  |   Encrypted SQLite    |  │      └─────────────────┘
└─────────────────┘      │  │   ┌───────────────┐   │  │      
                         │  │   │  WASM Plugins │   │  │
┌─────────────────┐      │  │   └───────────────┘   │  │
│  Web Interface  │      │  │                       │  │
│                 │      │  └───────────────────────┘  │
│  ┌───────────┐  │      │  ┌───────────────────────┐  │
│  │   Cert    │──┼──────┼─►│        Cert CA        │  │
│  │ Download  │  │      │  └───────────────────────┘  │
│  └───────────┘  │      └─────────────────────────────┘
└─────────────────┘
```

## ⚠️ Security Considerations

1. **Certificate Trust**: Installing the root certificate allows the proxy to decrypt all HTTPS traffic.
2. **Plugin capabilities**: Plugins only have the permissions you give them, but you are responsible for verifying those permissions are restricted appropriately.
    * Plugin execution can be limited using [CEL expressions](#todo), restricting when they're allowed to run. While plugins come with their own recommended defaults, users always have the ability to restrict them as they see fit.
    * Plugins may request [host capabilities](#todo), which you are responsible to decide whether or not to provide. `future work:` While `witmproxy` provides default implementations of capabilities we expect to be useful to plugin authors, as a user you may replace the implementation of capabilities granted to plugins.

## Supporting the project

Consider either [supporting the author directly](#todo), or supporting any of the maintainers of the projects that make `witmproxy` possible:
- [mitmproxy](https://github.com/sponsors/mhils) the inspiration for this project
- [sqlite](https://sqlite.org/consortium.html) the database engine used for storage
- [Tokio](https://github.com/sponsors/tokio-rs) the projects async runtime
- [hyper](https://github.com/sponsors/seanmonstar) the man-in-the-middle proxy server
- [salvo](https://salvo.rs/donate/index.html) the backend powering the web interface and API
- ...and more! (see [`cargo.toml`](./Cargo.toml) for a full list of our dependencies)

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## Acknowledgements

Projects which make `witmproxy` possible (but don't actively list direct sponsorship options):
- [Rust](https://rust-lang.org/) the programming language used to build this project
- [wasmtime](https://wasmtime.dev) the WebAssembly runtime that runs plugins
- [sqlcipher](https://www.zetetic.net/sqlcipher/) the encrypted database engine used for storage
- [rustls](https://github.com/rustls/rustls) the Rust TLS implementation

## License

This project is licensed under the AGPLv3 License, with a paid commercial license available on request.