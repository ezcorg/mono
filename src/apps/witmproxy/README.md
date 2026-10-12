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

### Running more than one witmproxy

A host can run several daemons side by side, each a named *instance* with
state of its own. `--instance <name>` (or `WITM_INSTANCE`) on any command
selects one; without it every command means the default instance, which is
what a single-daemon install already is. witmproxy only keeps instances
apart: which exist and what they bind is yours to decide (or a tool's, such
as rig).

```sh
# A second daemon on its own ports (Linux: prefix with sudo)
witm service install --instance agent-1 \
  --proxy-bind-addr 10.207.0.1:3129 --web-bind-addr 127.0.0.1:3130 -y
witm service start --instance agent-1
witm service status --instance agent-1   # the unit is ez-witmproxy@agent-1.service
witm service logs -f --instance agent-1

# Each instance is its own server, with its own accounts and login
witm auth login --instance agent-1 --email admin@localhost
witm plugin add @ezco/noop --instance agent-1
witm tenant list --instance agent-1

# Every instance on this host: name, root, unit state, bound addresses
witm service list
```

Per instance: the state directory (`/var/lib/witmproxy/instances/<name>` on
Linux, `~/.witmproxy/instances/<name>` elsewhere) holding its `config.toml`,
`policy.toml`, database, CA (`certs/`), `services.json` and logs; the
database key's keychain entry (`witmproxy@<name>`); the service unit
(`ez-witmproxy@<name>.service` on Linux, launchd label
`co.ez.witmproxy.<name>` on macOS); and the login token
(`~/.witmproxy/instances/<name>/auth.json`). Shared: the `witm` binary, and
the OS system-proxy setting — `witm proxy enable --instance <name>` points it
at that instance's proxy address, and only one instance can be the system
proxy at a time.

A name is 1 to 63 characters of `a-z`, `0-9`, `.`, `_` and `-`, starting
with a letter or digit.

#### Yours, not the host's: `--user`

On Linux a witmproxy is the host's by default: root installs it, its state
is under `/var/lib/witmproxy`, it runs as a system unit from boot. `--user`
(or `WITM_USER=1`) on any command means one of *your* witmproxys instead:
no root, state under `~/.local/state/witmproxy` (`instances/<name>` under
that), a `systemctl --user` unit in `~/.config/systemd/user`, the login
token in the instance's root. The two scopes are two namespaces, so your
`agent-1` and the host's `agent-1` never touch, and `witm service list
--user` lists yours.

```sh
witm service install --user --instance agent-1 \
  --proxy-bind-addr 127.0.0.1:3129 --web-bind-addr 127.0.0.1:3130 -y
witm service start --user --instance agent-1
systemctl --user status ez-witmproxy@agent-1
```

A user service runs while you are logged in. To have it survive logout and
start at boot, let your session manager linger (once, as root):
`sudo loginctl enable-linger $USER`. `service install --user` and `service
status --user` say when it does not.

Off Linux every witmproxy is a user's already (`~/.witmproxy`, a
LaunchAgent in `~/Library/LaunchAgents`), so `--user` changes nothing
there. A LaunchAgent lives as long as the login session; macOS has no
linger. A system-level install there (a LaunchDaemon with `UserName`, for a
daemon that must outlive logout) is not written yet.

### Certificate Installation

The `witm ca install` command installs the witmproxy root certificate into your system's trust store. This command may prompt for `sudo` on both Linux and macOS.

### 3. Add plugins

Plugins are how you can extend `witmproxy` with whatever functionality your heart desires.

```sh
witm plugin add @ezco/noop # add a plugin from the witmproxy.rs registry
witm plugin add ./path/to/component.wasm # add a local plugin
```

### Deploying plugins as files

`witm run --plugin-dir <dir>` loads every component in a directory and
reloads one when its file changes. A `<component>.toml` beside
`<component>.wasm` configures it the same way, so a tool that drives
witmproxy (rig does) writes two files and never touches the CLI or the tray
app:

```toml
[configuration]                  # inputs, typed as the manifest declares them
rules = '[...]'

[capabilities.handle_event_connect]   # scopes, conjoined with the manifest's:
when = "connect.host() in ['api.example.com']"   # a sidecar can only narrow
```

An input the plugin does not declare, or a capability it does not want,
refuses the whole file; a reload happens when either file is written,
renamed into place or removed.

### Policy: who may dial what

A forward proxy reaches whatever its host reaches, and a witmproxy with no
policy permits every dial, which is right for your own traffic. Fronting
clients that may reach less than you (a VM whose only way out is this
proxy, a device on a tailnet) wants rules. They are data, not plugins: the
instance's in `policy.toml` in its root (or `--policy-file`), a tenant's at
`PUT /api/manage/tenants/{id}/policy` as JSON of the same shape, evaluated
by the proxy for every connection it makes on a client's behalf: CONNECT
tunnels (refused with a `403` before the tunnel exists), intercepted
requests (in the upstream client's resolver), and the transparent proxy's
passthrough.

```toml
# policy.toml: the instance's floor
default = "permit"                      # what no rule decides; a tenant may set its own

[sets]
private = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16",
           "100.64.0.0/10", "127.0.0.0/8", "[::1]", "[fc00::]/7", "[fe80::]/10"]

[[rules]]
effect = "forbid"                       # permit | forbid
src = ["*"]                             # * | tenant:<id> | ip:<address or CIDR>
dst = ["@private:*"]                    # host:port; host is a name, *.suffix, an
comment = "this host's own networks"    # address, a CIDR, @set or *; port is a
                                        # number, lo-hi, a list or *
[[rules]]
effect = "permit"
src = ["ip:10.207.0.5"]
dst = ["api.example.com:443", "*.cache.example.org:443"]

[[checks]]                              # evaluated when the policy loads; one
src = "ip:10.207.0.5"                   # that fails refuses the policy
permit = ["api.example.com:443"]
forbid = ["api.example.com:80", "10.0.0.5:22"]
```

The algebra is Cedar's: any matching `forbid` denies, else any matching
`permit` allows, else the tenant's `default`, else the instance's, else
permit. No priorities, no first-match, so the instance's `forbid` is a
floor no tenant can lift, and a tenant's rules (whose `src` is always
`self`) can only widen what nothing forbids. A name pattern matches the
name the client asked for; a CIDR matches each address it resolved to, so
`permit api.example.com:443` beside `forbid @private:*` lets the name
through to its public addresses only. `--upstream-deny a,b,c` is shorthand
for one `forbid * -> a:*,b:*,c:*`. A request inside an intercepted
connection for a host other than the connection's own is refused with
`421` regardless.

```sh
# A tenant that may reach one API and nothing else
curl -X PUT https://127.0.0.1:3130/api/manage/tenants/vm-1/policy \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
    "default": "forbid",
    "rules": [{"effect": "permit", "dst": ["api.example.com:443"]}],
    "checks": [{"permit": ["api.example.com:443"], "forbid": ["example.com:443"]}]}'
```

A plugin's instance-wide settings are set the same way, at
`PUT /api/plugins/{ns}/{name}/config` with `{"config": {"<input>": "<value>"}}`,
each value typed as the plugin declares it; a tenant's own values
(`/api/manage/tenants/{id}/plugins/{ns}/{name}/config`) override them.

### 4. Creating a new plugin

```sh
witm plugin new <name> [...options] # creates plugin scaffolding
```

The witmproxy plugin WIT interface is automatically published to [GitHub Container Registry](https://ghcr.io) and can be consumed using [`wkg`](https://github.com/bytecodealliance/wasm-pkg-tools):

```sh
# Fetch the WIT interface for plugin development
wkg get --format wit witmproxy:plugin@0.0.8 --output plugin.wit
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
    * Plugin execution can be limited using [CEL expressions](#todo): a `when` clause restricts which events a plugin runs for, and an `allow` clause restricts every call it makes on a granted capability (which storage keys, how many log lines). While plugins come with their own recommended defaults, users always have the ability to restrict them as they see fit.
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

- **Rust toolchain**: pinned by [`rust-toolchain.toml`](../../../rust-toolchain.toml) at the repository root. rustup installs the channel, components, and targets (including `wasm32-wasip2` for plugin development) on first build, so no manual setup is needed
- **wkg**: The [`wkg`](https://github.com/bytecodealliance/wasm-pkg-tools) CLI is required for updating and fetching WIT (WebAssembly Interface Type) files used by the plugin interface

### Steps

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

### Troubleshooting

**`cargo build` fails in `cel-cxx-ffi` with `absolute path inclusion(s) found in rule '@@abseil-cpp+//absl/...'`**

`cel-cxx-ffi` builds `cel-cpp` with Bazel, which autodetects the system C++
toolchain once and caches it, recording the compiler's header directories as
absolute paths (`/usr/lib/gcc/x86_64-linux-gnu/14/include`, and so on). Bazel
does not invalidate that cache when the system compiler is upgraded in place, so
after a GCC major bump every header the new compiler pulls in looks like an
undeclared absolute include and the build fails on an unrelated-looking Abseil
target.

Nothing in this repository is wrong when this happens; it is stale local Bazel
state. Drop the cached toolchain description and let Bazel re-detect the
compiler:

```bash
find ~/.cache/bazel -maxdepth 5 -name '*local_config_cc*' -exec rm -rf {} +
```

The next `cargo build` regenerates it against the current compiler. Running
`bazel clean --expunge` in the vendored `cel` workspace works too, but discards
the entire cel-cpp build cache rather than just the toolchain description.

## Acknowledgements

Projects which make `witmproxy` possible (but don't actively list direct sponsorship options):
- [Rust](https://rust-lang.org/) the programming language used to build this project
- [wasmtime](https://wasmtime.dev) the WebAssembly runtime that runs plugins
- [sqlcipher](https://www.zetetic.net/sqlcipher/) the encrypted database engine used for storage
- [rustls](https://github.com/rustls/rustls) the Rust TLS implementation

## License

This project is licensed under the AGPLv3 License, with a paid commercial license available on request.