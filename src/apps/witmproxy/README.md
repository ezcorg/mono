# witmproxy <sup>⚠️ `under construction` 👷</sup>

A WASM-in-the-middle proxy, written in Rust.

## Quick Start

### 1. Installation and setup

```sh
# Install via shell script
curl -fsSL https://witmproxy.rs/install.sh | sh

# Or install from crates.io
cargo install witmproxy

# First run: installs daemon and attaches to logs
witm
# Run detached (start daemon without attaching to logs)
witm -d
```

On first run, `witm` automatically:
1. Installs the proxy as a system daemon (using launchd on macOS, systemd on Linux, or Windows Services)
2. Starts the daemon service
3. Attaches to the daemon's log output (unless `-d`/`--detach` is specified)

> **Linux:** Daemon management commands (`install`, `start`, `stop`, `restart`, `uninstall`) require root privileges. Run them with `sudo`. The `status` and `logs` commands do not require root.
>
> **macOS:** Uses user-level launchd, so no `sudo` is needed for daemon management.

### 2. Daemon management

```sh
# View daemon status (no sudo required)
witm service status

# Control the daemon (Linux: prefix with sudo)
witm service start    # Start the daemon
witm service stop     # Stop the daemon
witm service restart  # Restart the daemon

# View logs (no sudo required)
witm service logs          # Show last 50 lines of logs
witm service logs -f       # Follow logs in real-time (like tail -f)
witm service logs -l 100   # Show last 100 lines

# Manage installation (Linux: prefix with sudo)
witm service install    # Manually install the daemon
witm service uninstall  # Remove the daemon from the system
```

### Certificate Installation

The `witm ca install` command installs the witmproxy root certificate into your system's trust store. This command may prompt for `sudo` on both Linux and macOS.

### 3. Add plugins

Plugins are how you can extend `witmproxy` with whatever functionality your heart desires.

```sh
witm plugin add @ezco/noop # add a plugin from the witmproxy.rs registry
witm plugin add ./path/to/component.wasm # add a local plugin
```

### 4. Creating a new plugin

```sh
witm plugin new <name> [...options] # creates plugin scaffolding
```

The witmproxy plugin WIT interface is automatically published to [GitHub Container Registry](https://ghcr.io) and can be consumed using [`wkg`](https://github.com/bytecodealliance/wasm-pkg-tools):

```sh
# Fetch the WIT interface for plugin development
wkg get --format wit witmproxy:plugin@0.0.6 --output plugin.wit
```

###

## Architecture

A not-entirely-accurate but pretty LLM-generated diagram:

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

Consider either [supporting the author directly](https://github.com/sponsors/tbrockman), or supporting any of the maintainers of the projects that make `witmproxy` possible:
- [mitmproxy](https://github.com/sponsors/mhils) the inspiration for this project
- [sqlite](https://sqlite.org/consortium.html) the database engine used for storage
- [Tokio](https://github.com/sponsors/tokio-rs) the projects async runtime
- [hyper](https://github.com/sponsors/seanmonstar) the man-in-the-middle proxy server
- [salvo](https://salvo.rs/donate/index.html) the backend powering the web interface and API
- ...and more! (see [`cargo.toml`](./Cargo.toml) for a full list of our dependencies)

## Contributing

### Prerequisites

- **Nightly Rust**: `witmproxy` requires nightly Rust for development (`rustup default nightly` or use `+nightly` with cargo commands)
- **WASM target**: Plugin development requires the `wasm32-wasip2` target: `rustup target add wasm32-wasip2`
- **wkg**: The [`wkg`](https://github.com/bytecodealliance/wasm-pkg-tools) CLI is required for updating and fetching WIT (WebAssembly Interface Type) files used by the plugin interface

### Steps

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