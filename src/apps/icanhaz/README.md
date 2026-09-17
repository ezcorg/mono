# `icanhaz`

> a system-wide capability daemon: web apps, editors and agents reach the
> **real** capabilities a machine has (its files, processes, shell, models,
> change notifications), each one consented, scoped, revocable and shareable.

Built on **NoCap** (Negotiated Object-Capability Protocol): a requester asks
for a capability by kind, a human grants it with a scope, and what comes back
is an object that *is* the capability. `icanhazd` is the daemon; the tray app
in `app/` embeds it and is the consent surface; `web/` is the browser client
the markdown editor uses.

The design of record is the platform RFC (`src/typescript/markdown-editor/docs/gap-analysis-and-platform-rfc.md`,
§13 scoping, §14 authoring, §15 import resolution, §16 work plan). This file
is the map of what is built.

## Everything is a component

Every capability the daemon serves is a **WebAssembly component** served over
**wRPC**, and every capability interface is **resource-shaped**: the grant
token is presented once, at `open(grant)`, and the object returned carries no
token in its methods. The daemon keeps that object for the connection that
acquired it and admits each method under the grant it was opened with.

```
browser / editor / agent ──wRPC──▶ router ──▶ [wrapper …] ──▶ shipped capability ──▶ raw host layer
                                     │                                                 (icanhaz:nocap/gate-*,
                                     └─ handle registry, one per daemon                 process-raw, pty, notify,
                                        (icanhaz:nocap/resources.drop)                  providers, jail)
```

- **Shipped capabilities** live in `capabilities/<name>/`, one crate each:
  `filesystem` (real `wasi:filesystem@0.2` over wRPC, jailed to the daemon's
  root), `process`, `terminal`, `watch`, `workspace`, `inference`. Each imports
  only WASI and the raw host layer declared in `wit/host.wit`, which the daemon
  implements in `host/src/raw.rs` from its native providers.
- **Wrappers and chains.** A grant can be *provided through* components chosen
  at consent (`via`). The daemon composes them with `wac` in front of the
  shipped capability and instantiates the composition in its own store; the
  chain lives while a grant names it. A wrapper refuses, rewrites or audits
  without the capability knowing.
- **Novel capabilities** are components added to the store (`icanhaz
  capability add`) exporting an interface nothing native provides. They are
  served through the same router, and their imports of native capabilities
  are satisfied by composing the shipped components in, running under grants
  the requester **delegates** to them.
- **Scopes** are CEL clauses (`ezco:ezcap`) over an environment generated from
  the interface's WIT: `call.method`, `call.args.*`, `state.*`, `time`. They
  narrow only, render as sentences in the consent window, and are checked at
  the gate on every operation.
- **Sharing.** A grant travels as a signed certificate bound to an audience;
  redeemed at the issuing broker (locally, or over **iroh** from another
  machine) it becomes a grant of the recipient's own, and calls on it are
  forwarded to the broker that holds the source.

## Repository layout

```
src/apps/icanhaz/
  wit/            the daemon's WIT: broker, components, configuration, the
                  capability interfaces, host.wit (raw layer), nocap.wit (types,
                  resources.drop); deps/ fetched by `wkg wit fetch` (git-ignored)
  broker/         icanhaz-broker: grant store, scopes, certificates, consent,
                  pairings, durable state (also embedded by witmproxy)
  host/           icanhaz-host: the daemon (serving layer, router, raw layer,
                  providers, component store, scaffold) and the binaries
    src/bin/icanhazd.rs   the headless daemon
    src/bin/icanhaz.rs    the CLI (capability inspect|add|list|get|compose|new|wrap)
    fixtures/             test fixtures and the crates they are built from
    templates/            what `icanhaz capability new|wrap` scaffolds
  capabilities/   the shipped capability components (wasm32-wasip2 crates)
  app/            the tray app (Tauri): embeds the daemon, consent window,
                  grants, configuration, the component store
  web/            @joinezco/icanhaz-web: the browser client (wRPC over one
                  multiplexed WebSocket or WebTransport), generated stubs,
                  the VFS over the filesystem capability, the terminal block,
                  the remote LSP provider, share bundles; browser tests
```

## Running it

Build the wasm guests once (the shipped capabilities and the test fixtures,
from the daemon's WIT; needs `wkg` and the `wasm32-wasip2` target):

```sh
src/apps/icanhaz/scripts/build-wasm.sh
```

Then either the tray app (`cd src/apps/icanhaz/app && pnpm tauri dev`) or the
headless daemon:

```sh
ICANHAZ_CONSENT=auto cargo run --bin icanhazd
```

`icanhazd` reads `ICANHAZ_WS_BIND`, `ICANHAZ_WT_BIND`, `ICANHAZ_ROOT` (the
filesystem jail), `ICANHAZ_CAPABILITIES_DIR`, `ICANHAZ_CONSENT`
(`auto` | `deny` | `approve` over `ICANHAZ_APPROVE_BIND`), `ICANHAZ_PAIRINGS`,
`ICANHAZ_HOSTS`, `ICANHAZ_DB` and `ICANHAZ_DB_KEY`, `ICANHAZ_IROH` (`0` to skip
the peer endpoint), `ICANHAZ_CERT` and `ICANHAZ_KEY` for WebTransport TLS, and
`ICANHAZ_ECHO=1` for a loopback inference model.

## Tests

```sh
src/scripts/check-icanhaz.sh                      # what CI runs: lint, the wasm guests, host + broker tests
cargo test -p icanhaz-host -p icanhaz-broker     # host: each capability, routing, chains, handles, iroh, scaffold
cd src/apps/icanhaz/web && pnpm test:browser      # browser: starts its own daemon on free ports
```

The browser suite builds `icanhazd`, launches it with auto consent, a
throwaway jail and the echo model, and exercises every capability end to end
from a real page. Fixture components under `host/fixtures/` are committed;
see the README there.

## Authoring a capability

```sh
icanhaz capability wrap icanhaz:nocap/process@0.1.0   # a wrapper: forwards every method, ready to refuse or rewrite
icanhaz capability new mine --export example:mine/mine@0.1.0 --wit ./wit   # a novel capability
cargo build --release --target wasm32-wasip2 --target-dir target
icanhaz capability inspect target/wasm32-wasip2/release/<crate>.wasm
icanhaz capability add     target/wasm32-wasip2/release/<crate>.wasm
```

A scaffold vendors the daemon's WIT, generates the `Guest` impls (resource
wrappers included) and an `AGENTS.md` with the rules: imports are capabilities
only, authority comes from the grant, keep the WIT's asyncness. Once added,
the component is offered in the consent window for every grant kind it gates.
